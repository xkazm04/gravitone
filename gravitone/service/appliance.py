"""The Sealed Appliance — what this artifact IS, as a checkable fact.

The product's claim is sovereignty: it synthesizes, listens, diarizes and
converses on the box you already own, with the cable pulled. Until now that
claim was an intention held up by prose. Nothing in the running artifact could
answer the only two questions a disconnected buyer asks:

    "Is everything it needs actually inside this image?"
    "Prove it — file by file."

This module answers both. It walks the baked model tree (``/opt/gravitone/models``
by default, ``GRAVITONE_MODELS_DIR`` to move it) and emits a canonical manifest:
every model file with its sha256 and its upstream provenance, the locales the
box can speak, the capabilities that follow from what is present, and the
package versions behind them. ``GET /v1/appliance`` serves it, so a running box
can be asked what it is and the answer can be diffed against the one handed over
with the tarball.

Integrity/authenticity reuse service/packs.py's proven pattern EXACTLY: a
canonical JSON serialization (sorted keys, no spaces, ``signature`` excluded)
and an optional HMAC-SHA256 when a secret is configured
(``TTS_APPLIANCE_SECRET``, falling back to ``TTS_PACK_SECRET``). No new crypto,
no new format vocabulary.

**Unsealed is a first-class answer, not an error.** A dev checkout has no baked
tree, and the honest report is "unsealed" together with the NAMES of what is
missing and the exact command that would produce it — never a 500, never a
silently-empty ``models: []`` that reads like "nothing to see here". A sealed
image reports ``seal: "sealed"``; a slim (``--build-arg MODELS_STAGE=nobake``)
image reports ``"unsealed"`` and says so out loud, which is the whole point: an
operator must never discover at first call that the weights were going to be
downloaded from the internet.

CLI (used by the Dockerfile's bake stage, and useful on any box):

    python -m service.appliance            # print the manifest
    python -m service.appliance --seal     # write SEAL.json into the model tree
    python -m service.appliance --check    # exit 1 unless the tree is sealed
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import platform
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

logger = logging.getLogger("gravitone.appliance")

router = APIRouter(tags=["appliance"])

FORMAT = "gravitone-appliance/1"

# Where the bake stage puts the weights, and where the runtime image points
# HF_HOME / STT_DOWNLOAD_ROOT / DIARIZE_MODELS_DIR / PIPER_VOICES_DIR.
DEFAULT_ROOT = "/opt/gravitone/models"
SEAL_FILE = "SEAL.json"

# Bounds. The manifest hashes real model files (whisper-small alone is ~460 MB),
# so it is computed ONCE per process and cached — an unbounded re-hash per
# request would be a free way to pin a CPU-only box.
MAX_FILES = 4096
_HASH_CHUNK = 1 << 20


def _secret() -> str:
    """Read at call time, not import time, so a test can set it."""
    return os.environ.get("TTS_APPLIANCE_SECRET") or os.environ.get("TTS_PACK_SECRET", "")


@dataclass(frozen=True)
class Component:
    """One baked capability: a directory, who it belongs to, where it came from.

    ``env`` is the runtime variable the image points at this directory. It is
    carried in the manifest because "the weights are baked" and "the process
    will actually look there" are two different claims, and only the second one
    keeps the box offline.
    """

    name: str
    dirname: str
    env: str
    capability: str
    provenance: str
    license: str
    remedy: str


COMPONENTS: tuple[Component, ...] = (
    Component(
        name="pocket-tts",
        dirname="hf",
        env="HF_HOME",
        capability="synthesize",
        provenance="huggingface.co (pocket-tts weights, fetched by pocket_tts.TTSModel.load_model)",
        # Not asserted by this repo. See LICENSE-REVIEW in the manifest.
        license="see-upstream",
        remedy="python -c \"from pocket_tts import TTSModel; TTSModel.load_model()\"",
    ),
    Component(
        name="whisper",
        dirname="whisper",
        env="STT_DOWNLOAD_ROOT",
        capability="speech_to_text",
        provenance="huggingface.co Systran/faster-whisper-* (CTranslate2 conversion of OpenAI Whisper)",
        license="see-upstream",
        remedy="python -c \"from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root='<root>/whisper')\"",
    ),
    Component(
        name="diarization",
        dirname="diarization",
        env="DIARIZE_MODELS_DIR",
        capability="diarize",
        # The two URLs live in service/diarize.py; repeated here as provenance
        # strings only (a copy that drifts is caught by test_appliance).
        provenance="github.com/k2-fsa/sherpa-onnx releases (pyannote-segmentation-3.0 + WeSpeaker CAM++)",
        license="MIT (segmentation) / Apache-2.0 (CAM++) per service/diarize.py",
        remedy="DIARIZE_MODELS_DIR=<root>/diarization python -m service.diarize --download",
    ),
    Component(
        name="piper-voices",
        dirname="piper_voices",
        env="PIPER_VOICES_DIR",
        capability="speak_other_languages",
        provenance="huggingface.co rhasspy/piper-voices (python -m piper.download_voices)",
        license="MIT (Piper); per-voice datasets vary — see each voice's MODEL_CARD",
        remedy="python -m piper.download_voices --download-dir <root>/piper_voices <voice_id>",
    ),
)

# Model licensing for REDISTRIBUTION inside an image is a legal review step, not
# a code step (packaging-deployment.md M1, "Risks"). The manifest says so in
# band rather than letting a `license` field imply a clearance nobody granted.
LICENSE_REVIEW = (
    "UNRESOLVED: redistribution of these weights inside a shipped image has not "
    "been legally cleared. Piper itself is MIT; the Whisper/CTranslate2 "
    "conversion and the sherpa-onnx model releases each need confirming before "
    "this artifact is handed to a third party."
)


def models_root(root: Path | str | None = None) -> Path:
    if root is not None:
        return Path(root)
    return Path(os.environ.get("GRAVITONE_MODELS_DIR", DEFAULT_ROOT))


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(_HASH_CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _scan(directory: Path) -> tuple[list[dict], int]:
    """Every regular file under ``directory``, hashed, relative-pathed, sorted.

    Symlinks are recorded but NOT followed: the HuggingFace cache is a tree of
    ``snapshots/*`` links onto ``blobs/*``, and following them would hash every
    weight twice and inflate the reported byte total by 2x.
    """
    entries: list[dict] = []
    truncated = 0
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            entries.append({"path": path.relative_to(directory).as_posix(),
                            "link": os.readlink(path), "sha256": None,
                            "bytes": None})
            continue
        if not path.is_file():
            continue
        if len(entries) >= MAX_FILES:
            truncated += 1
            continue
        entries.append({"path": path.relative_to(directory).as_posix(),
                        "bytes": path.stat().st_size,
                        "sha256": _sha256(path)})
    return entries, truncated


def _piper_locales(directory: Path) -> list[str]:
    """"cs_CZ-jirka-medium.onnx" -> "cs_CZ". Filenames are the inventory."""
    locales = set()
    if directory.is_dir():
        for path in directory.glob("*.onnx"):
            head = path.stem.split("-", 1)[0]
            if head:
                locales.add(head)
    return sorted(locales)


def _package_versions() -> dict:
    """What is INSTALLED, independent of what is baked.

    Both halves matter and they fail differently: missing weights make a sealed
    box download at first call, a missing package makes the capability absent
    no matter what is on disk. The old Dockerfile shipped exactly the second
    failure (faster-whisper / sherpa-onnx / piper-tts were never installed), so
    this is reported explicitly rather than inferred from the model tree.
    """
    from importlib import metadata

    versions: dict[str, str | None] = {}
    for dist in ("pocket-tts", "faster-whisper", "sherpa-onnx", "piper-tts",
                 "fastapi", "torch"):
        try:
            versions[dist] = metadata.version(dist)
        except Exception:  # noqa: BLE001 - absence IS the answer here
            versions[dist] = None
    versions["python"] = platform.python_version()
    return versions


def _canonical(manifest: dict) -> bytes:
    """Byte-identical to packs.py's canonicalization, on purpose."""
    unsigned = {k: v for k, v in manifest.items() if k != "signature"}
    return json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()


def _sign(manifest: dict) -> dict:
    secret = _secret()
    if secret:
        manifest["signature"] = {
            "alg": "HMAC-SHA256",
            "value": hmac.new(secret.encode(), _canonical(manifest),
                              hashlib.sha256).hexdigest(),
        }
    return manifest


def verify_signature(manifest: dict, secret: str | None = None) -> bool:
    """Whether ``manifest`` carries a signature this instance's secret makes.

    The receiving half of the handover: the tarball ships a manifest, the box
    serves one, and an auditor compares. Fails closed on a missing signature —
    same reasoning as packs.import_pack, where accepting an unsigned document
    when a secret is configured is a one-field downgrade attack.
    """
    key = _secret() if secret is None else secret
    sig = manifest.get("signature") or {}
    if not key or not sig:
        return False
    want = hmac.new(key.encode(), _canonical(manifest), hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, str(sig.get("value", "")))


def build_manifest(root: Path | str | None = None, *, sign: bool = True) -> dict:
    """The canonical description of this appliance. Pure; does no I/O beyond
    reading the model tree, and never raises for an absent one."""
    base = models_root(root)
    models: list[dict] = []
    missing: list[dict] = []
    present: dict[str, bool] = {}
    total_bytes = 0
    truncated = 0

    for comp in COMPONENTS:
        directory = base / comp.dirname
        entries, cut = ([], 0) if not directory.is_dir() else _scan(directory)
        truncated += cut
        hashed = [e for e in entries if e.get("sha256")]
        present[comp.name] = bool(hashed)
        if not hashed:
            missing.append({
                "component": comp.name,
                "capability": comp.capability,
                "expected_dir": str(directory),
                "why": ("the directory is absent" if not directory.is_dir()
                        else "the directory holds no model files"),
                "remedy": comp.remedy.replace("<root>", str(base)),
            })
            continue
        for entry in hashed:
            total_bytes += entry.get("bytes") or 0
        models.append({
            "component": comp.name,
            "dir": str(directory),
            "env": comp.env,
            # A baked tree the process does not look at is not a sealed box.
            "env_points_here": os.environ.get(comp.env, "") == str(directory),
            "provenance": comp.provenance,
            "license": comp.license,
            "files": entries,
        })

    piper_dir = next(base / c.dirname for c in COMPONENTS if c.name == "piper-voices")
    piper_locales = _piper_locales(piper_dir)
    # Pocket TTS speaks English and French (service/piper.py docstring); Piper
    # adds exactly the languages whose voice files are on disk. Reported as
    # language tags ("cs"), which is what convai dispatches on, with the full
    # per-voice locales kept beside them.
    speak = sorted({loc.split("_", 1)[0].lower() for loc in piper_locales}
                   | ({"en", "fr"} if present.get("pocket-tts") else set()))
    versions = _package_versions()

    sealed = all(present.get(c.name) for c in COMPONENTS if c.name != "piper-voices")
    manifest = {
        "format": FORMAT,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "gravitone",
        "root": str(base),
        "seal": "sealed" if sealed else "unsealed",
        "image_digest": os.environ.get("GRAVITONE_IMAGE_DIGEST", ""),
        "offline_enforced": os.environ.get("HF_HUB_OFFLINE", "") in ("1", "true", "on"),
        "models": models,
        "model_bytes": total_bytes,
        "files_truncated": truncated,
        "locales": {"speak": speak, "piper_voices": piper_locales,
                    "listen": ("multilingual (whisper)" if present.get("whisper")
                               else "absent")},
        "capabilities": {
            "synthesize": bool(present.get("pocket-tts") and versions.get("pocket-tts")),
            "clone": bool(present.get("pocket-tts") and versions.get("pocket-tts")),
            "speech_to_text": bool(present.get("whisper") and versions.get("faster-whisper")),
            "diarize": bool(present.get("diarization") and versions.get("sherpa-onnx")),
            "speak_other_languages": bool(piper_locales and versions.get("piper-tts")),
            # The conversational agent needs ears AND a mouth co-resident. This
            # is the line the old image failed: it shipped neither half.
            "converse": bool(present.get("pocket-tts") and present.get("whisper")
                             and versions.get("faster-whisper")),
        },
        "versions": versions,
        "missing": missing,
        "license_review": LICENSE_REVIEW,
    }
    seal = read_seal(base)
    if seal:
        manifest["baked"] = {k: seal.get(k) for k in
                             ("baked_at", "image_ref", "piper_voices", "stt_model")
                             if k in seal}
    return _sign(manifest) if sign else manifest


def read_seal(root: Path | str | None = None) -> dict | None:
    """The bake stage's own note about what it fetched, or None."""
    path = models_root(root) / SEAL_FILE
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("appliance: %s is unreadable; ignoring it", path)
        return None
    return data if isinstance(data, dict) else None


def write_seal(root: Path | str | None = None) -> Path:
    """Record the bake. Called INSIDE the bake stage, where the fetch just
    happened and the environment that produced it is still knowable."""
    base = models_root(root)
    base.mkdir(parents=True, exist_ok=True)
    manifest = build_manifest(base)
    seal = {
        "baked_at": manifest["generated_at"],
        "image_ref": os.environ.get("GRAVITONE_IMAGE_REF", ""),
        "stt_model": os.environ.get("STT_MODEL", ""),
        "piper_voices": _piper_locales(base / "piper_voices"),
        "components": [m["component"] for m in manifest["models"]],
        "model_bytes": manifest["model_bytes"],
        "versions": manifest["versions"],
    }
    path = base / SEAL_FILE
    path.write_text(json.dumps(seal, indent=2, sort_keys=True), "utf-8")
    return path


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
# One process, one immutable model tree: hash it once. `?refresh=true` exists
# for the dev box where the tree IS changing under the process.
_CACHE: dict[str, dict] = {}
_CACHE_LOCK = threading.Lock()


def cached_manifest(refresh: bool = False) -> dict:
    key = str(models_root())
    if not refresh:
        hit = _CACHE.get(key)
        if hit is not None:
            return hit
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit is not None and not refresh:
            return hit
        manifest = build_manifest()
        _CACHE.clear()          # bounded by construction: one root per process
        _CACHE[key] = manifest
        return manifest


@router.get("/v1/appliance")
def get_appliance(refresh: bool = False, verify: bool = False) -> dict:
    """What this box is: baked models with hashes, locales, capabilities.

    Always 200, including on an unsealed dev box — "unsealed, and here is
    exactly what is missing" is an answer, not a failure. ``verify=true``
    re-checks the manifest's own HMAC (a 500 there would mean this process
    disagrees with itself, which is worth a loud error).
    """
    manifest = cached_manifest(refresh=refresh)
    if verify:
        if not _secret():
            raise HTTPException(
                400, "no TTS_APPLIANCE_SECRET (or TTS_PACK_SECRET) is configured "
                     "on this instance, so the manifest is unsigned and there is "
                     "nothing to verify")
        if not verify_signature(manifest):
            raise HTTPException(500, "the appliance manifest failed its own "
                                     "signature check")
    return manifest


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:  # pragma: no cover - thin shell
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m service.appliance",
        description="Describe (or seal) the baked model tree of this appliance.")
    parser.add_argument("--root", default=None,
                        help=f"model tree (default $GRAVITONE_MODELS_DIR or {DEFAULT_ROOT})")
    parser.add_argument("--seal", action="store_true",
                        help="write SEAL.json into the tree (run this in the bake stage)")
    parser.add_argument("--check", action="store_true",
                        help="exit 1 unless every non-optional component is baked")
    args = parser.parse_args(argv)

    if args.seal:
        print(f"sealed: {write_seal(args.root)}")
    manifest = build_manifest(args.root)
    print(json.dumps(manifest, indent=2))
    if args.check and manifest["seal"] != "sealed":
        names = ", ".join(m["component"] for m in manifest["missing"]) or "?"
        print(f"!! UNSEALED — missing: {names}")
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
