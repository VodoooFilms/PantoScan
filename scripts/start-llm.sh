#!/usr/bin/env bash
set -euo pipefail

MODEL="${DOC_LLM_MODEL:-}"
if [ -z "$MODEL" ]; then
  MODEL="$(node -e "try{process.stdout.write(require(process.env.HOME+'/.config/analicedocumental/config.json').llmModel||'')}catch(e){}" 2>/dev/null || true)"
fi
if [ -z "$MODEL" ]; then
  echo "define DOC_LLM_MODEL o 'llmModel' en ~/.config/analicedocumental/config.json" >&2
  exit 1
fi
PORT="${DOC_LLM_PORT:-8081}"
HOST="${DOC_LLM_HOST:-127.0.0.1}"
PYTHON="${DOC_LLM_PYTHON:-$HOME/.mlx-env/bin/python}"

echo "MLX server  ${MODEL}  →  http://${HOST}:${PORT}/v1"
exec "$PYTHON" -m mlx_lm server --model "$MODEL" --host "$HOST" --port "$PORT"
