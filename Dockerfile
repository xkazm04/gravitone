# Arm64 / Neoverse image for the Pocket Voice TTS service.
# Base = Arm's optimized PyTorch build (aarch64 + oneDNN + Arm Compute Library,
# and — on recent tags — KleidiAI). Build & run this on an Arm64 host
# (Graviton / Axion / Cobalt / Ampere) or with `docker buildx --platform linux/arm64`.
FROM armswdev/pytorch-arm-neoverse:latest

WORKDIR /app

# ffmpeg is needed for mp3 output + the clone pipeline.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The base image already ships an Arm-optimized torch. Install pocket-tts and
# the service deps WITHOUT pulling a second torch (keep the base's build).
# If pip tries to replace torch, pin/keep it: `pip install --no-deps pocket-tts`
# then add its runtime deps explicitly.
RUN pip install --no-cache-dir \
        pocket-tts fastapi "uvicorn[standard]" scipy psutil python-multipart

COPY service/ ./service/
COPY voices/ ./voices/

# Arm inference optimizations (see SUBMISSION.md). Tune WORKERS/THREADS per box;
# for full-core utilization run multiple single-worker replicas instead.
ENV ONEDNN_DEFAULT_FPMATH_MODE=bf16 \
    TTS_HOST=0.0.0.0 \
    TTS_PORT=8080 \
    TTS_WORKERS=1 \
    TTS_TORCH_THREADS=4 \
    OMP_NUM_THREADS=4

EXPOSE 8080
CMD ["python", "-m", "service.app"]
