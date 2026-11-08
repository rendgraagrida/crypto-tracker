#!/bin/bash
set -euo pipefail
# Manual, session-only operations. Does not install software, write launchctl, or change sleep policy.
if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' 'Script ini hanya untuk macOS.' >&2
  exit 1
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-check}" in
  check)
    command -v ollama >/dev/null || { printf '%s\n' 'Pasang Ollama native macOS dari situs resmi terlebih dahulu.' >&2; exit 1; }
    ollama --version
    printf '%s\n' 'Pastikan RAM, memory pressure, swap, dan beban runner Gomoku diperiksa sebelum inference.'
    ;;
  create)
    command -v ollama >/dev/null
    # Requires an already running local Ollama and a separately downloaded model.
    OLLAMA_HOST=127.0.0.1:11434 ollama create hermes-crypto-analyst -f "$SCRIPT_DIR/Modelfile"
    ;;
  serve)
    command -v ollama >/dev/null
    export OLLAMA_HOST=127.0.0.1:11434
    export OLLAMA_NO_CLOUD=1
    export OLLAMA_CONTEXT_LENGTH=4096
    export OLLAMA_NUM_PARALLEL=1
    export OLLAMA_MAX_LOADED_MODELS=1
    export OLLAMA_MAX_QUEUE=4
    export OLLAMA_KEEP_ALIVE=5m
    # Optional optimizations: test accuracy/memory on this exact model before enabling.
    if [ "${HERMES_FLASH_ATTENTION:-0}" = 1 ]; then
      export OLLAMA_FLASH_ATTENTION=1
      export OLLAMA_KV_CACHE_TYPE="${HERMES_KV_CACHE_TYPE:-q8_0}"
    fi
    if [ "${HERMES_KEEP_AWAKE_AC:-0}" = 1 ]; then
      exec caffeinate -s ollama serve
    fi
    exec ollama serve
    ;;
  smoke)
    command -v curl >/dev/null
    command -v node >/dev/null || { printf '%s\n' 'Node.js 24+ proyek diperlukan untuk validasi schema smoke.' >&2; exit 1; }
    curl -fsS --max-time 8 http://127.0.0.1:11434/v1/chat/completions \
      -H 'content-type: application/json' \
      -d '{"model":"hermes-crypto-analyst","temperature":0,"max_tokens":80,"response_format":{"type":"json_schema","json_schema":{"name":"findings","strict":true,"schema":{"type":"object","properties":{"finding_ids":{"type":"array","items":{"type":"string","enum":["liquidity_ratio","holder_concentration"]},"maxItems":2}},"required":["finding_ids"],"additionalProperties":false}}},"messages":[{"role":"system","content":"Prioritize supplied evidence IDs only. Return JSON."},{"role":"user","content":"{\"available\":[\"liquidity_ratio\",\"holder_concentration\"],\"metrics\":{\"liquidityToMarketCap\":0.02,\"topHolderPercent\":25}}"}]}' \
      | node --input-type=module -e '
let size=0; const chunks=[];
for await (const chunk of process.stdin) { size+=chunk.length; if(size>16384) throw Error("Model response exceeds 16 KiB"); chunks.push(chunk); }
const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
const content=body?.choices?.[0]?.message?.content;
if(typeof content!=="string"||content.length>2048) throw Error("Invalid model content");
const value=JSON.parse(content);
if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==1||!Array.isArray(value.finding_ids)||value.finding_ids.length>2||value.finding_ids.some(id=>!["liquidity_ratio","holder_concentration"].includes(id))||new Set(value.finding_ids).size!==value.finding_ids.length) throw Error("Model schema rejected");
console.log(JSON.stringify({status:"schema-valid",finding_ids:value.finding_ids}));
'
    ;;
  tunnel)
    : "${HERMES_VPS_SSH:?Set HERMES_VPS_SSH ke akun SSH terbatas yang sudah disetujui}"
    exec ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -R 127.0.0.1:11435:127.0.0.1:11434 "$HERMES_VPS_SSH"
    ;;
  *) printf '%s\n' 'Usage: bash mac-hermes.sh check|serve|create|smoke|tunnel' >&2; exit 1 ;;
esac
