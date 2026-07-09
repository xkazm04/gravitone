#!/usr/bin/env bash
# Clone a voice from a recording and generate a test sentence.
#
# Usage:
#   ./clone_test.sh recordings/myvoice.mp3 ["custom test sentence"]
#
# Steps:
#   1. ffmpeg -> clean 24 kHz mono wav (highpass + loudnorm) in recordings/processed/
#   2. export-voice -> voices/<name>.safetensors (fast to reuse later)
#   3. generate with the cloned voice -> samples/<name>.wav
#
# Kyutai's tips: 10-30s of CLEAN single-speaker speech clones best. The sample's
# audio quality is reproduced, so denoise/clean noisy recordings first.
set -euo pipefail

IN="${1:?usage: ./clone_test.sh <audio-file> [test-text]}"
TEXT="${2:-Hi, this is my cloned voice speaking through Pocket TTS. Does this sound like me?}"

NAME="$(basename "${IN%.*}" | tr ' ' '_')"
CLEAN="recordings/processed/${NAME}.wav"
VOICE="voices/${NAME}.safetensors"
OUT="samples/${NAME}.wav"

echo "==> [1/3] Converting '$IN' -> clean 24kHz mono wav"
ffmpeg -y -i "$IN" -af "highpass=f=80,loudnorm" -ac 1 -ar 24000 "$CLEAN" -loglevel error
echo "    wrote $CLEAN ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLEAN")s)"

echo "==> [2/3] Exporting voice embedding -> $VOICE"
uv run --no-dev pocket-tts export-voice "$CLEAN" "$VOICE"

echo "==> [3/3] Generating test sentence -> $OUT"
uv run --no-dev pocket-tts generate --voice "$VOICE" --text "$TEXT" --output-path "$OUT"

echo ""
echo "DONE. Cloned voice: $VOICE"
echo "      Test sample:  $OUT"
