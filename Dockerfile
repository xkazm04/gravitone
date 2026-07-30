# The Sealed Appliance — an Arm64 image that speaks, listens, diarizes and
# converses with the network cable pulled.
#
# Base = Arm's optimized PyTorch build (aarch64 + oneDNN + Arm Compute Library,
# and — on recent tags — KleidiAI). Build & run this on an Arm64 host
# (Graviton / Axion / Cobalt / Ampere) or with `docker buildx --platform linux/arm64`.
#
# Two things this file exists to prevent, both of which it used to cause:
#
#   1. AN IMAGE THAT CANNOT DO WHAT THE REPO DOES. The dependency list was
#      hand-copied inline and had drifted: faster-whisper, sherpa-onnx and
#      piper-tts were missing, so the shipped container could not listen, could
#      not diarize, could not speak a non-English language, and /v1/convai/* was
#      dead on arrival — in every deploy path (bootstrap -> CFN -> Helm), which
#      all inherit this image. It now installs from requirements.txt, the real
#      dependency set, and a build-time import gate FAILS THE BUILD if any of
#      those capabilities is not importable.
#
#   2. AN IMAGE THAT PHONES HOME ON FIRST BOOT. Every weight used to be fetched
#      at first use from Hugging Face / GitHub, so the sovereign product needed
#      egress before it could say a word. The `bake` stage below downloads all
#      of them at BUILD time into /opt/gravitone/models, the runtime stage
#      copies that tree into an immutable layer, and the cache env vars point at
#      it with HF_HUB_OFFLINE=1 — so a missing bake fails LOUDLY instead of
#      silently re-downloading.
#
# Variants:
#   docker build -t gravitone .                            # sealed (default)
#   docker build --build-arg MODELS_STAGE=nobake \
#                --build-arg HF_HUB_OFFLINE=0 -t gravitone:slim .
# The slim image is small and NOT sealed: it downloads on first use exactly as
# the old image did, and GET /v1/appliance reports "unsealed" and names what is
# missing. That report is the contract — nobody has to guess which one they got.
#
# What the appliance reports (service/appliance.py, GET /v1/appliance):
#   per-file sha256 + upstream provenance, locales, capabilities, versions,
#   and, when TTS_APPLIANCE_SECRET is set, an HMAC over the canonical manifest
#   (the same pattern service/packs.py already ships for character packs).

ARG BASE_IMAGE=armswdev/pytorch-arm-neoverse:latest
# Which stage supplies /opt/gravitone/models: `bake` (default, sealed) or
# `nobake` (empty tree, slim variant). Docker cannot make a COPY conditional,
# so the choice is made by aliasing the stage — and with MODELS_STAGE=nobake
# BuildKit never runs the downloads at all.
ARG MODELS_STAGE=bake
ARG HF_HUB_OFFLINE=1
ARG MODELS_DIR=/opt/gravitone/models
# Which whisper size is baked in. "small" is service/config.py's default and the
# smallest model that reliably keeps domain nouns intact (~460 MB). Global,
# because the bake stage fetches it and the runtime stage must ASK FOR THE SAME
# ONE — a runtime STT_MODEL the bake never fetched is exactly the silent
# re-download HF_HUB_OFFLINE exists to turn into a loud failure.
ARG BAKE_STT_MODEL=small


# ---------------------------------------------------------------------------
# base — deps + code. Shared by the bake stage and the runtime stage, so the
# downloaders run against exactly the libraries that will later load the files.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS base

WORKDIR /app

# ffmpeg is needed for mp3 output + the clone pipeline.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The base image already ships an Arm-optimized torch (oneDNN + ACL + KleidiAI).
# requirements.txt pulls pocket-tts, which depends on torch — plain pip would
# happily replace that build with a generic PyPI wheel and silently lose the
# whole reason this base image was chosen. So: pin the INSTALLED torch version
# as a constraint first, install everything else against it, then assert the
# build did not move. A constraint (not a requirement) means torch is simply
# already satisfied and is never touched.
COPY requirements.txt ./
RUN python -c "import torch, pathlib; pathlib.Path('/tmp/torch-constraint.txt').write_text('torch==' + torch.__version__.split('+')[0] + '\n')" \
    && cat /tmp/torch-constraint.txt \
    && TORCH_BEFORE="$(python -c 'import torch; print(torch.__version__)')" \
    && pip install --no-cache-dir -c /tmp/torch-constraint.txt -r requirements.txt \
    && TORCH_AFTER="$(python -c 'import torch; print(torch.__version__)')" \
    && [ "$TORCH_BEFORE" = "$TORCH_AFTER" ] \
       || { echo "!! pip replaced the base image's torch ($TORCH_BEFORE -> $TORCH_AFTER)"; exit 1; }

COPY service/ ./service/
COPY voices/ ./voices/
COPY agents/ ./agents/

# The capability gate. This is the assertion whose absence let a listen-less
# image ship: if any of the four capability modules cannot import, the BUILD
# fails here rather than the product failing at a customer's first conversation.
# (The end-to-end version — clone -> synth -> stt -> convai turn under
# `docker run --network none` — is .github/workflows/sealed.yml.)
RUN python -c "import faster_whisper, sherpa_onnx, piper, pocket_tts; \
import service.stt, service.piper, service.diarize, service.convai, service.appliance; \
print('capability import gate: ok')"


# ---------------------------------------------------------------------------
# bake — every weight, fetched once, at build time.
# ---------------------------------------------------------------------------
FROM base AS bake
ARG MODELS_DIR
ARG BAKE_STT_MODEL
# Which Piper voices are baked in. DELIBERATELY SMALL: each medium voice is
# ~60 MB of image, and Pocket TTS already covers English and French, so the
# default set is the languages it CANNOT speak, ordered by who actually asks —
# Czech first because it is this repo's own worked example of the failure Piper
# exists to fix (a Czech caller heard correctly and answered in English
# phonetics). Override for a deployment that needs others:
#   --build-arg BAKE_PIPER_VOICES="cs_CZ-jirka-medium pl_PL-darkman-medium"
# Empty ("") bakes no Piper voices: still a sealed appliance (English/French
# only), which is why service/appliance.py treats piper as the one optional
# component.
ARG BAKE_PIPER_VOICES="cs_CZ-jirka-medium de_DE-thorsten-medium es_ES-davefx-medium pt_BR-faber-medium"

ENV GRAVITONE_MODELS_DIR=${MODELS_DIR} \
    HF_HOME=${MODELS_DIR}/hf \
    XDG_CACHE_HOME=${MODELS_DIR}/cache \
    STT_MODEL=${BAKE_STT_MODEL} \
    STT_DOWNLOAD_ROOT=${MODELS_DIR}/whisper \
    DIARIZE_MODELS_DIR=${MODELS_DIR}/diarization \
    PIPER_VOICES_DIR=${MODELS_DIR}/piper_voices \
    HF_HUB_DISABLE_TELEMETRY=1

RUN mkdir -p "$HF_HOME" "$STT_DOWNLOAD_ROOT" "$DIARIZE_MODELS_DIR" "$PIPER_VOICES_DIR"

# 1/4 — the mouth. pocket-tts weights land in HF_HOME.
RUN python -c "from pocket_tts import TTSModel; TTSModel.load_model(language='english', quantize=False); print('pocket-tts baked')"

# 2/4 — the ears. CTranslate2 int8 conversion of Whisper; the constructor is
# what performs the fetch, and it is given the same download_root the runtime
# reads from STT_DOWNLOAD_ROOT.
RUN python -c "import os; from faster_whisper import WhisperModel; \
WhisperModel(os.environ['STT_MODEL'], device='cpu', compute_type='int8', download_root=os.environ['STT_DOWNLOAD_ROOT']); \
print('whisper baked')"

# 3/4 — who spoke when. Pure stdlib downloader, no account, no token.
RUN python -m service.diarize --download

# 4/4 — the other languages. One voice at a time so a single bad name is a
# named failure rather than a silent partial set.
RUN set -eu; for voice in ${BAKE_PIPER_VOICES}; do \
        echo "baking piper voice $voice"; \
        python -m piper.download_voices --download-dir "$PIPER_VOICES_DIR" "$voice"; \
    done

# Record what was baked, then REFUSE to produce a sealed image that isn't.
# --check exits non-zero unless every non-optional component is present, so a
# download that half-failed cannot become an artifact that claims to be sealed.
RUN python -m service.appliance --seal --check


# ---------------------------------------------------------------------------
# nobake — the slim variant's empty model tree. Same base, so no extra pull.
# ---------------------------------------------------------------------------
FROM base AS nobake
ARG MODELS_DIR
RUN mkdir -p ${MODELS_DIR} && printf '%s\n' \
    "This image is NOT sealed: it was built with --build-arg MODELS_STAGE=nobake." \
    "No weights are baked in; they download on first use and this box needs egress." \
    "GET /v1/appliance reports seal=unsealed and names every missing component." \
    > ${MODELS_DIR}/UNSEALED.txt


# Alias whichever of the two stages was selected.
FROM ${MODELS_STAGE} AS models


# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ARG MODELS_DIR
ARG HF_HUB_OFFLINE
ARG BAKE_STT_MODEL

COPY --from=models ${MODELS_DIR} ${MODELS_DIR}

# Arm inference optimizations. ONEDNN_DEFAULT_FPMATH_MODE is ALSO applied by
# service/replicas.py::replica_env (setdefault) so a bare-metal replica run
# matches this image instead of silently losing bf16 fast-math; keeping it here
# covers the plain `python -m service.app` CMD below.
# Tune WORKERS/THREADS per box;
# for full-core utilization run multiple single-worker replicas instead.
# Ingest jobs are DURABLE by design (per-job workdir + state.json, rehydrated
# on restart). That only holds if the directory outlives the container, so it
# lives under a declared mount point — the default REPO_ROOT/ingest_jobs would
# be inside the writable layer and vanish on every restart, silently making the
# whole rehydrate path dead code in the shipped image.
ENV ONEDNN_DEFAULT_FPMATH_MODE=bf16 \
    TTS_HOST=0.0.0.0 \
    TTS_PORT=8080 \
    TTS_WORKERS=1 \
    TTS_TORCH_THREADS=4 \
    OMP_NUM_THREADS=4 \
    INGEST_WORK_DIR=/app/ingest_jobs \
    TTS_DRAIN_TIMEOUT_S=20

# The seal, in environment form. Every one of these points a loader at the
# baked tree, and service/appliance.py reports per component whether the
# variable actually resolves there — "the weights are in the image" and "the
# process will look for them there" are two different claims and only the
# second one keeps the box offline.
#
# HF_HUB_OFFLINE=1 is the loud-failure switch: with it, a weight that was NOT
# baked raises at load instead of being quietly re-downloaded, which is the
# difference between an appliance and a program that happens to have run
# offline once. The slim build passes 0.
ENV GRAVITONE_MODELS_DIR=${MODELS_DIR} \
    HF_HOME=${MODELS_DIR}/hf \
    XDG_CACHE_HOME=${MODELS_DIR}/cache \
    STT_MODEL=${BAKE_STT_MODEL} \
    STT_DOWNLOAD_ROOT=${MODELS_DIR}/whisper \
    DIARIZE_MODELS_DIR=${MODELS_DIR}/diarization \
    PIPER_VOICES_DIR=${MODELS_DIR}/piper_voices \
    HF_HUB_OFFLINE=${HF_HUB_OFFLINE} \
    TRANSFORMERS_OFFLINE=${HF_HUB_OFFLINE} \
    HF_HUB_DISABLE_TELEMETRY=1

RUN mkdir -p /app/ingest_jobs
VOLUME ["/app/ingest_jobs"]

EXPOSE 8080
# NOTE: stop this container with a grace period LONGER than
# TTS_DRAIN_TIMEOUT_S (e.g. `docker stop -t 30`); the 10s default SIGKILLs
# the service mid-drain.
#
# Ask a running box what it is:
#   docker run --rm --network none gravitone python -m service.appliance --check
CMD ["python", "-m", "service.app"]
