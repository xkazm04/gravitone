"""Qwen vision — what is ON the screen, scene by scene.

One frame per scene goes to Qwen3.8 (a native vision-language model) over
Alibaba's DashScope OpenAI-compatible endpoint, and comes back as a small,
structured description: setting, action, who is visible, whether the speaker
is on screen, mood. That is everything the narration director needs; nothing
here does OCR transcripts, face databases or lip sync.

Posture (mirrors the cloud half of ingest.py):
  * KEY-GATED CLOUD CALL. Frames leave the machine only when QWEN_API_KEY is
    configured and the caller chose a visual pass. `available()` is the probe;
    the sovereign path simply never imports a reason to call this.
  * stdlib urllib only, like ingest.py's `_call` — no SDK dependency.
  * every request charges a `Spend` ledger when one is passed; retries respect
    the caller's retry budget and back off on 429/5xx/timeouts only. A
    permanent 4xx is an answer, not a retry.
  * a MALFORMED answer is a different failure from an unreachable provider,
    and is repaired the way the text brain repairs its own (`brain.py`
    `complete_json`): the parse failure is quoted back once, at temperature 0.
    Only after that does the batch degrade.
  * failures degrade PER BATCH to None entries; the caller decides whether a
    scene without a description is fatal. Raw response bodies go to the log,
    never to a response body of ours.
  * every scene carries WHY it has no description (`description_status`, set
    on the caller's own scene dict): "the model was never asked about this
    shot" and "the model answered and we could not read it" are different
    facts and a narrator would act differently on each.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

from service.config import _int, _str  # the house env readers

logger = logging.getLogger("gravitone.vision")

#: DashScope's OpenAI-compatible endpoint (international). QWEN_BASE_URL
#: overrides for the mainland endpoint or a local vLLM serving open-weight
#: Qwen3-VL — the payload shape is identical, which is the point of the
#: compatible mode.
BASE_URL = _str("QWEN_BASE_URL",
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")
MODEL = _str("QWEN_VISION_MODEL", "qwen3.8-max")

#: DASHSCOPE_API_KEY is the vendor's own variable name; honoured so an
#: operator with an existing environment does not have to duplicate it.
def _key() -> str:
    return (os.environ.get("QWEN_API_KEY", "").strip()
            or os.environ.get("DASHSCOPE_API_KEY", "").strip())


TIMEOUT_S = float(_str("QWEN_TIMEOUT", "") or 120)
#: Scenes per request. Eight ~360p JPEGs is a comfortably small payload and
#: keeps one bad batch from costing every description.
BATCH = _int("QWEN_VISION_BATCH", 8)
RETRY_ATTEMPTS = _int("QWEN_RETRY_ATTEMPTS", 3)

_PROVIDER = "qwen"


class VisionError(RuntimeError):
    """Named, user-safe: the message never carries the provider's body."""


def available() -> bool:
    """Whether the visual pass could run — a key is configured. Whitespace is
    not a key (the same trap `have_cloud_keys` guards against)."""
    return bool(_key())


_SYSTEM = (
    "You describe video scenes for a voiceover writer. You are given numbered "
    "scenes, each with one representative frame and optional context. Answer "
    "ONLY with JSON: {\"scenes\": [{\"index\": <int>, "
    "\"setting\": <where this takes place, few words>, "
    "\"action\": <what is happening, one short sentence>, "
    "\"people\": <who is visible: count and brief roles, or 'nobody'>, "
    "\"speaker_on_screen\": <true|false|null if no context says who speaks>, "
    "\"mood\": <one or two words>, "
    "\"caption\": <one vivid sentence a narrator could build on>}]}. "
    "One entry per scene, same index. Describe only what is visible; never "
    "invent names or read lips."
)


#: Why a scene has no description. The split that matters: NO_FRAME and
#: CANCELLED mean the model was never asked about this shot; UNREADABLE and
#: OMITTED mean it answered and we could not use the answer. A narrator told
#: "nobody looked" and a narrator told "we looked and could not read it"
#: should not behave the same way, so the job's scene records carry which.
DESCRIBED = "described"
NO_FRAME = "no_frame"
CANCELLED = "cancelled"
UNREADABLE = "unreadable"
OMITTED = "omitted_from_answer"

#: The statuses that mean the model never saw this scene.
NEVER_ASKED = (NO_FRAME, CANCELLED)


def describe_scenes(scenes: list[dict], *, context: str = "",
                    spend=None,
                    should_cancel: Callable[[], bool] | None = None) -> list[dict | None]:
    """One structured description per scene, aligned by position.

    `scenes` entries carry `i`, `start`, `end`, `frame` (a Path or str to a
    JPEG on disk) and optionally `text` (what is being said during the scene,
    when a transcript exists) and `speaker` (the diarized voice). Entries
    whose frame is missing come back None without costing a call.

    Returns a list the same length as `scenes`; None marks "no description".
    The REASON is not only logged: each scene dict is stamped with
    `description_status` (one of the constants above), so a caller can tell a
    scene nobody looked at from a scene whose answer was unreadable.
    """
    if not available():
        raise VisionError("QWEN_API_KEY is not configured — the visual pass "
                          "is off on this box")
    out: list[dict | None] = [None] * len(scenes)
    status: list[str] = [NO_FRAME] * len(scenes)
    todo = [k for k, s in enumerate(scenes) if _frame_of(s) is not None]
    for lo in range(0, len(todo), BATCH):
        batch = todo[lo:lo + BATCH]
        if should_cancel and should_cancel():
            for k in todo[lo:]:
                status[k] = CANCELLED
            break
        try:
            got = _describe_batch([scenes[k] for k in batch], context=context,
                                  spend=spend)
        except VisionError as exc:
            logger.warning("vision batch %s..%s degraded: %s",
                           batch[0], batch[-1], exc)
            for k in batch:
                status[k] = UNREADABLE
            continue
        for k, desc in zip(batch, got):
            out[k] = desc
            status[k] = DESCRIBED if desc is not None else OMITTED
    _stamp(scenes, status)
    return out


def _stamp(scenes: list[dict], status: list[str]) -> None:
    """Record on each scene WHY it does (not) have a description. Mutating the
    caller's own record is deliberate: the fact belongs to the scene, and the
    job persists scenes, not this function's return value."""
    for s, why in zip(scenes, status):
        if isinstance(s, dict):
            s["description_status"] = why


def _frame_of(scene: dict) -> Path | None:
    raw = scene.get("frame")
    if not raw:
        return None
    p = Path(raw)
    return p if p.is_file() else None


_REPAIR = (
    "Your previous answer could not be parsed as the JSON that was asked for "
    "({reason}). Answer again about the SAME scenes, with ONLY the valid JSON "
    "document described in your instructions — no prose, no code fences, one "
    "entry per scene, same indices."
)


def _describe_batch(scenes: list[dict], *, context: str, spend) -> list[dict | None]:
    """One batch → one aligned answer, repaired once if it comes back malformed.

    Same doctrine as `brain.complete_json`: a model fixes its own JSON far
    more reliably than a regex fixes it for the model, so the parse failure is
    quoted back and the question asked again at temperature 0. Exactly one
    repair — a second malformed answer is an answer, and the caller degrades
    the batch per scene rather than failing the job.
    """
    messages = _messages(scenes, context=context)
    indices = [s["i"] for s in scenes]
    body = _post(_payload(messages), spend=spend)
    try:
        return _align(body, indices)
    except VisionError as first:
        logger.warning("vision answer for scenes %s..%s unreadable (%s) — "
                       "asking the model to repair it", indices[0],
                       indices[-1], first)
        repair = messages + [{"role": "user", "content": [
            {"type": "text", "text": _REPAIR.format(reason=first)}]}]
    body = _post(_payload(repair, temperature=0.0), spend=spend)
    return _align(body, indices)


def _payload(messages: list[dict], *, temperature: float = 0.2) -> dict:
    return {
        "model": MODEL,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": temperature,
    }


def _messages(scenes: list[dict], *, context: str) -> list[dict]:
    content: list[dict] = []
    if context:
        content.append({"type": "text", "text": f"Video context: {context}"})
    for s in scenes:
        line = (f"Scene {s['i']} ({s.get('start', 0):.0f}-"
                f"{s.get('end', 0):.0f}s)")
        if s.get("speaker"):
            line += f" — voice heard: {s['speaker']}"
        if s.get("text"):
            line += f" — being said: “{str(s['text'])[:300]}”"
        content.append({"type": "text", "text": line})
        frame = _frame_of(s)
        b64 = base64.b64encode(frame.read_bytes()).decode("ascii")
        content.append({"type": "image_url", "image_url": {
            "url": f"data:image/jpeg;base64,{b64}"}})
    return [{"role": "system", "content": _SYSTEM},
            {"role": "user", "content": content}]


def _post(payload: dict, *, spend) -> dict:
    """POST /chat/completions with the ingest retry doctrine: 429/5xx/timeout
    retry against the budget, permanent 4xx raises immediately."""
    data = json.dumps(payload).encode("utf-8")
    url = f"{BASE_URL.rstrip('/')}/chat/completions"
    last: Exception | None = None
    for attempt in range(RETRY_ATTEMPTS):
        req = urllib.request.Request(url, data=data, method="POST", headers={
            "Authorization": f"Bearer {_key()}",
            "Content-Type": "application/json"})
        if spend is not None:
            spend.charge(_PROVIDER)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            tail = ""
            try:
                tail = exc.read(300).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001 - the body is a bonus, never a crash
                pass
            logger.warning("qwen http %s: %s", exc.code, tail)
            if exc.code in (408, 429) or exc.code >= 500:
                last = exc
            else:
                raise VisionError(f"the vision provider refused the request "
                                  f"(HTTP {exc.code})")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            logger.warning("qwen transport failure: %r", exc)
            last = exc
        except ValueError as exc:
            raise VisionError("the vision provider answered with something "
                              "that is not JSON")
        if attempt + 1 < RETRY_ATTEMPTS:
            if spend is not None and not spend.take_retry():
                break
            time.sleep(min(2.0 * (attempt + 1), 8.0))
    raise VisionError("the vision provider could not be reached "
                      f"({type(last).__name__ if last else 'exhausted'})")


def _members(body: dict) -> list:
    """The answer's scene array, or `ValueError` saying what was wrong with it.

    The reason is the whole point: it is what gets quoted back to the model in
    the repair turn, so it must name the defect, not just report one."""
    try:
        text = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError("the answer carried no message content")
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"it is not valid JSON: {exc}")
    members = parsed.get("scenes") if isinstance(parsed, dict) else parsed
    if not isinstance(members, list):
        raise ValueError('it has no "scenes" array')
    return members


def _align(body: dict, indices: list[int]) -> list[dict | None]:
    """Provider JSON → one entry per requested scene, by declared index."""
    try:
        members = _members(body)
    except ValueError as exc:
        logger.warning("qwen answer unparseable: %s", str(body)[:300])
        raise VisionError(f"the vision answer could not be parsed — {exc}")
    by_index: dict[int, dict] = {}
    for m in members:
        if isinstance(m, dict) and isinstance(m.get("index"), int):
            by_index[m["index"]] = {
                "setting": str(m.get("setting") or "").strip(),
                "action": str(m.get("action") or "").strip(),
                "people": str(m.get("people") or "").strip(),
                "speaker_on_screen": (m["speaker_on_screen"]
                                      if isinstance(m.get("speaker_on_screen"), bool)
                                      else None),
                "mood": str(m.get("mood") or "").strip(),
                "caption": str(m.get("caption") or "").strip(),
                "model": MODEL,
            }
    return [by_index.get(i) for i in indices]
