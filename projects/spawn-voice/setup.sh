#!/bin/bash
# One-time setup for spawn-voice: build whisper.cpp's server and fetch the model.
# Safe to re-run. Usage: bash setup.sh [model]   (default base.en)
set -euo pipefail
cd "$(dirname "$0")"
MODEL="${1:-${WHISPER_MODEL:-base.en}}"
if [ ! -x whisper.cpp/build/bin/whisper-server ]; then
  [ -d whisper.cpp ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git whisper.cpp
  cmake -S whisper.cpp -B whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF
  cmake --build whisper.cpp/build -j"$(nproc)" --target whisper-server
fi
mkdir -p models
if [ ! -s "models/ggml-$MODEL.bin" ]; then
  curl -fL -o "models/ggml-$MODEL.bin.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
  mv "models/ggml-$MODEL.bin.part" "models/ggml-$MODEL.bin"
fi
[ -d node_modules/ws ] || npm install --omit=dev
echo "spawn-voice ready (model $MODEL)"
