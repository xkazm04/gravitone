"""The text brain — one-shot LLM completions behind one provider seam.

dialog.py already owns CONVERSATION (streamed sentences, history, live turn
latency). This module owns DIRECTION: single request → single structured
answer, for jobs that think in batch — the narration director, the emotion
composer, the fit rewriter. The two stay separate because their contracts
differ: dialog streams parts and never blocks a turn on perfect output;
direction wants exactly one JSON document and will pay a retry to get it.

Backends, selected by BRAIN_LLM:
  * ``claude-cli``    — headless ``claude -p`` on this machine's subscription;
                        no key, frontier quality, seconds of latency. The
                        local prototyping default.
  * ``openai-compat`` — any /chat/completions server, configured explicitly
                        via BRAIN_BASE_URL / BRAIN_MODEL / BRAIN_API_KEY.
  * presets ``qwen`` / ``openai`` / ``gemini`` / ``claude-api`` — the same
    OpenAI-compat client pointed at the vendor's compatible endpoint with its
    conventional key variable, so switching cloud is one env var, not code.

Doctrine:
  * blocking; call from worker threads (jobs), never from the event loop.
  * provider bodies go to the log; callers see `BrainError` with authored
    copy (errors.sanitize_detail keeps UserFacing-style strings intact).
  * `complete_json` validates and retries ONCE with the parse failure quoted
    back — self-repair, not hope.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from service.config import SETTINGS, _int, _str

logger = logging.getLogger("gravitone.brain")

TIMEOUT_S = float(_str("BRAIN_TIMEOUT", "") or 120)
MAX_TOKENS = _int("BRAIN_MAX_TOKENS", 4000)
RETRY_ATTEMPTS = _int("BRAIN_RETRY_ATTEMPTS", 2)

#: Vendor presets: (base_url, default model, key env vars in order). One
#: OpenAI-compatible client serves all of them — that is the point.
_PRESETS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "qwen": ("https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
             "qwen3.8-max", ("QWEN_API_KEY", "DASHSCOPE_API_KEY")),
    "openai": ("https://api.openai.com/v1",
               "gpt-5.2", ("OPENAI_API_KEY",)),
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai",
               "gemini-3.6-flash", ("GEMINI_API_KEY",)),
    "claude-api": ("https://api.anthropic.com/v1",
                   "claude-sonnet-5", ("ANTHROPIC_API_KEY",)),
}


class BrainError(RuntimeError):
    """Named, user-safe. The message says which backend and what to do."""


class Brain:
    name = "brain"

    def describe(self) -> dict:
        raise NotImplementedError

    def complete(self, prompt: str, *, system: str = "",
                 temperature: float = 0.4,
                 max_tokens: int | None = None) -> str:
        raise NotImplementedError

    def complete_json(self, prompt: str, *, system: str = "",
                      temperature: float = 0.2,
                      max_tokens: int | None = None) -> dict:
        """One JSON document, or `BrainError`. A malformed first answer is
        quoted back once — models fix their own JSON far more reliably than a
        regex fixes it for them."""
        raw = self.complete(prompt, system=system, temperature=temperature,
                            max_tokens=max_tokens)
        try:
            return _parse_json(raw)
        except ValueError as first:
            repair = (f"{prompt}\n\nYour previous answer could not be parsed "
                      f"as JSON ({first}). Answer again with ONLY the valid "
                      "JSON document — no prose, no code fences.")
            raw = self.complete(repair, system=system, temperature=0.0,
                                max_tokens=max_tokens)
            try:
                return _parse_json(raw)
            except ValueError:
                logger.warning("%s: unparseable JSON after repair: %s",
                               self.name, raw[:300])
                raise BrainError("the model did not produce a readable plan — "
                                 "try again, or switch BRAIN_LLM to a stronger "
                                 "backend")


def _parse_json(raw: str) -> dict:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`\n")
        if text.lower().startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object found")
    parsed = json.loads(text[start:end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("top level is not an object")
    return parsed


class ClaudeCliBrain(Brain):
    """Headless ``claude -p``: one prompt on stdin, one text answer on stdout.

    Same disarmament as dialog.ClaudeCliBackend (whose DISALLOWED list is
    imported, not copied): the director must not be one hallucination away
    from a shell. `--output-format text` because this contract is one
    document, not a stream.
    """

    name = "claude-cli"

    def __init__(self, command: str | None = None, model: str | None = None,
                 timeout_s: float | None = None):
        self.command = command or SETTINGS.claude_cli_command
        self.model = (model or _str("BRAIN_CLAUDE_MODEL", "")
                      or SETTINGS.claude_cli_model)
        self.timeout_s = timeout_s or max(TIMEOUT_S,
                                          SETTINGS.claude_cli_timeout_s)

    def describe(self) -> dict:
        return {"backend": self.name, "command": self.command,
                "model": self.model or "cli default"}

    def available(self) -> bool:
        import shutil
        return bool(shutil.which(self.command)) or Path(self.command).is_file()

    def _executable(self) -> str:
        import shutil
        resolved = shutil.which(self.command)
        if resolved:
            return resolved
        if Path(self.command).is_file():
            return self.command
        raise BrainError(
            f"the Claude CLI was not found (command={self.command!r}). "
            "Install it, or point BRAIN_LLM at a served model.")

    def complete(self, prompt: str, *, system: str = "",
                 temperature: float = 0.4,
                 max_tokens: int | None = None) -> str:
        from service.dialog import ClaudeCliBackend
        argv = [self._executable(), "-p", "--output-format", "text",
                "--setting-sources", "", "--strict-mcp-config",
                "--exclude-dynamic-system-prompt-sections",
                "--disallowed-tools", *ClaudeCliBackend.DISALLOWED]
        if system:
            argv += ["--system-prompt", system]
        if self.model:
            argv += ["--model", self.model]
        try:
            r = subprocess.run(argv, input=prompt.encode("utf-8"),
                               capture_output=True, timeout=self.timeout_s)
        except subprocess.TimeoutExpired:
            raise BrainError(f"the Claude CLI took over {self.timeout_s:.0f}s "
                             "— raise BRAIN_TIMEOUT or use a served model")
        except OSError as exc:
            logger.error("claude cli failed to start: %s", exc)
            raise BrainError("the Claude CLI could not be started on this box")
        if r.returncode != 0:
            logger.warning("claude cli exit %s: %s", r.returncode,
                           (r.stderr or b"")[-400:])
            raise BrainError("the Claude CLI refused this request — see the "
                             "service log")
        return (r.stdout or b"").decode("utf-8", "replace").strip()


class OpenAiCompatBrain(Brain):
    """One non-streaming /chat/completions client for every served vendor."""

    name = "openai-compat"

    def __init__(self, base_url: str, model: str, api_key: str = "",
                 label: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        if label:
            self.name = label

    def describe(self) -> dict:
        return {"backend": self.name, "base_url": self.base_url,
                "model": self.model}

    def complete(self, prompt: str, *, system: str = "",
                 temperature: float = 0.4,
                 max_tokens: int | None = None) -> str:
        messages = ([{"role": "system", "content": system}] if system else [])
        messages.append({"role": "user", "content": prompt})
        payload = {"model": self.model, "messages": messages,
                   "temperature": temperature,
                   "max_tokens": max_tokens or MAX_TOKENS}
        data = json.dumps(payload).encode("utf-8")
        url = f"{self.base_url}/chat/completions"
        last: Exception | None = None
        for attempt in range(RETRY_ATTEMPTS + 1):
            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            req = urllib.request.Request(url, data=data, method="POST",
                                         headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                    body = json.loads(resp.read().decode("utf-8", "replace"))
                try:
                    return str(body["choices"][0]["message"]["content"] or "")
                except (KeyError, IndexError, TypeError):
                    logger.warning("%s: unexpected answer shape: %s",
                                   self.name, str(body)[:300])
                    raise BrainError(f"the {self.name} model answered in an "
                                     "unexpected shape")
            except urllib.error.HTTPError as exc:
                tail = ""
                try:
                    tail = exc.read(300).decode("utf-8", "replace")
                except Exception:  # noqa: BLE001 - the body is a bonus, never a crash
                    pass
                logger.warning("%s http %s: %s", self.name, exc.code, tail)
                if exc.code in (408, 429) or exc.code >= 500:
                    last = exc
                else:
                    raise BrainError(f"the {self.name} model refused the "
                                     f"request (HTTP {exc.code}) — check "
                                     "BRAIN_MODEL and the API key")
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                logger.warning("%s transport failure: %r", self.name, exc)
                last = exc
            except ValueError:
                raise BrainError(f"the {self.name} model answered with "
                                 "something that is not JSON")
            if attempt < RETRY_ATTEMPTS:
                time.sleep(min(2.0 * (attempt + 1), 8.0))
        raise BrainError(f"could not reach the {self.name} model at "
                         f"{self.base_url} "
                         f"({type(last).__name__ if last else 'exhausted'})")


def make_brain(kind: str | None = None) -> Brain:
    """BRAIN_LLM → a backend, with named fallbacks and authored errors.

    ``auto`` prefers the Claude CLI when it is installed (local prototyping,
    no key), then the first vendor preset whose key is configured.
    """
    kind = (kind or _str("BRAIN_LLM", "auto")).strip().lower()
    if kind in ("claude-cli", "claude"):
        return ClaudeCliBrain()
    if kind == "openai-compat":
        base = _str("BRAIN_BASE_URL", "")
        if not base:
            raise BrainError("BRAIN_LLM=openai-compat needs BRAIN_BASE_URL")
        return OpenAiCompatBrain(base, _str("BRAIN_MODEL", "") or "default",
                                 os.environ.get("BRAIN_API_KEY", ""))
    if kind in _PRESETS:
        base, model, key_vars = _PRESETS[kind]
        key = next((os.environ.get(v, "").strip() for v in key_vars
                    if os.environ.get(v, "").strip()), "")
        if not key:
            raise BrainError(f"BRAIN_LLM={kind} needs {key_vars[0]} in the "
                             "environment")
        return OpenAiCompatBrain(base, _str("BRAIN_MODEL", "") or model, key,
                                 label=kind)
    if kind == "auto":
        cli = ClaudeCliBrain()
        if cli.available():
            return cli
        for preset, (base, model, key_vars) in _PRESETS.items():
            key = next((os.environ.get(v, "").strip() for v in key_vars
                        if os.environ.get(v, "").strip()), "")
            if key:
                return OpenAiCompatBrain(base, model, key, label=preset)
        raise BrainError("no text brain is available: install the Claude CLI "
                         "or configure one of QWEN_API_KEY / OPENAI_API_KEY / "
                         "GEMINI_API_KEY / ANTHROPIC_API_KEY")
    raise BrainError(f"unknown BRAIN_LLM '{kind}' — use claude-cli, "
                     "openai-compat, qwen, openai, gemini, claude-api or auto")
