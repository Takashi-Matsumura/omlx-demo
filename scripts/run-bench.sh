#!/bin/bash
# oMLX と llama.cpp を「片方ずつ」起動して、両方の計測順で全シナリオを測る。
#
#   1周目 (A): llama.cpp → oMLX
#   2周目 (B): oMLX → llama.cpp
#   各周の前に休止（COOLDOWN 秒）を入れる。熱による速度低下の影響を、計測順の入れ替えで打ち消すため。
#
# 推論サーバはこのスクリプトが子プロセスとして起動・停止する（launchd などの常駐設定には触れない）。
# 事前に 8000 / 8080 番を使う常駐サーバは止め、`npm run dev` で Web アプリを起動しておくこと。
#
# 使い方:
#   LLAMA_MODEL=/path/to/gemma-4-12b-it-Q4_K_M.gguf scripts/run-bench.sh
#
# 結果: bench-results/<ホスト名>-<日時>/ に JSONL と、集計結果 summary.md を保存する。
set -u

# ---- 設定（環境変数で上書きできる） ----
APP_URL=${APP_URL:-http://localhost:3000}
LLAMA_SERVER=${LLAMA_SERVER:-$(command -v llama-server || echo /opt/homebrew/bin/llama-server)}
LLAMA_MODEL=${LLAMA_MODEL:-}
LLAMA_MMPROJ=${LLAMA_MMPROJ:-}          # 任意。MacBook Air の計測では mmproj も読み込んでいた
LLAMA_PORT=${LLAMA_PORT:-8080}
LLAMA_CTX=${LLAMA_CTX:-32768}
OMLX_CLI=${OMLX_CLI:-/Applications/oMLX.app/Contents/MacOS/omlx-cli}
OMLX_MODEL_DIR=${OMLX_MODEL_DIR:-$HOME/.omlx/models}
OMLX_CACHE_DIR=${OMLX_CACHE_DIR:-$HOME/.omlx/cache}
OMLX_PORT=${OMLX_PORT:-8000}
RUNS=${RUNS:-3}                          # 通常シナリオの繰り返し回数
P4_RUNS=${P4_RUNS:-5}                    # 同時4リクエストの繰り返し回数
COOLDOWN=${COOLDOWN:-300}                # 各周の前の休止秒数
SCENARIOS=${SCENARIOS:-"short long longCached parallel parallel4 parallel8 parallel16 mixed"}
# 多人数シナリオ（parallel8 / parallel16 / mixed）用の共有サーバ設定
SHARED_SLOTS=${SHARED_SLOTS:-16}         # 同時処理数（両サーバ共通）
SHARED_CTX=${SHARED_CTX:-65536}          # llama-server の KV 全体の長さ（--kv-unified で全スロットが共有）

cd "$(dirname "$0")/.." || exit 1
OUT="bench-results/$(scutil --get LocalHostName 2>/dev/null || hostname -s)-$(date +%Y%m%d-%H%M%S)"
LOG="$OUT/run.log"
SERVER_PID=""
SERVER_CFG=""  # 起動中のサーバの設定。同じ設定なら起動し直さない

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
die() { log "ERROR: $*"; exit 1; }

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID"
    for _ in $(seq 1 30); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$SERVER_PID" 2>/dev/null && kill -9 "$SERVER_PID"
  fi
  SERVER_PID=""
  SERVER_CFG=""
}
trap 'stop_server' EXIT
trap 'log "中断しました"; exit 130' INT TERM

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_up() { # $1=url  ロード中は 503 を返すので 200 になるまで待つ
  for _ in $(seq 1 180); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = 200 ] && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

warm() { # $1=base_url $2=model  モデルを読み込ませてから測る
  curl -s -o /dev/null "$1/chat/completions" -H 'content-type: application/json' \
    -d "{\"model\":\"$2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":8}"
}

same_cfg() { [ "$SERVER_CFG" = "$1" ] && [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; }

start_llama() { # $1=parallel $2=ctx $3=unified(1/0)
  local cfg="llama:$*"
  same_cfg "$cfg" && return 0
  stop_server
  local args=(-m "$LLAMA_MODEL" --host 127.0.0.1 --port "$LLAMA_PORT" -ngl 999 --metrics
    --cache-reuse 256 -c "$2" --parallel "$1" --flash-attn on)
  # --parallel を明示すると KV は既定で各スロットに分割される（1本あたり ctx/parallel）。
  # 共有サーバ設定では --kv-unified で全スロットが1つの KV を共有し、長いプロンプトも入るようにする
  [ "$3" = 1 ] && args+=(--kv-unified)
  [ -n "$LLAMA_MMPROJ" ] && args+=(--mmproj "$LLAMA_MMPROJ")
  "$LLAMA_SERVER" "${args[@]}" >>"$OUT/llama-server.log" 2>&1 &
  SERVER_PID=$!
  wait_up "http://127.0.0.1:$LLAMA_PORT/v1/models" || die "llama-server が起動しません（$OUT/llama-server.log を確認）"
  warm "http://127.0.0.1:$LLAMA_PORT/v1" "$(basename "$LLAMA_MODEL")"
  SERVER_CFG=$cfg
  log "llama-server 起動（--parallel $1 -c $2$([ "$3" = 1 ] && echo " --kv-unified")）"
}

start_omlx() { # $1=同時処理数（空なら oMLX の既定値）
  local cfg="omlx:${1:-default}"
  same_cfg "$cfg" && return 0
  stop_server
  local args=(serve --model-dir "$OMLX_MODEL_DIR" --host 127.0.0.1 --port "$OMLX_PORT"
    --paged-ssd-cache-dir "$OMLX_CACHE_DIR" --paged-ssd-cache-max-size 30GB)
  [ -n "${1:-}" ] && args+=(--max-concurrent-requests "$1")
  "$OMLX_CLI" "${args[@]}" >>"$OUT/omlx.log" 2>&1 &
  SERVER_PID=$!
  wait_up "http://127.0.0.1:$OMLX_PORT/v1/models" || die "oMLX が起動しません（$OUT/omlx.log を確認）"
  warm "http://127.0.0.1:$OMLX_PORT/v1" "${OMLX_MODEL:-gemma-4-12B-it-4bit}"
  SERVER_CFG=$cfg
  log "oMLX 起動（同時処理数 ${1:-既定値}）"
}

run_one() { # $1=target $2=scenario $3=runs $4=jsonl
  local res
  res=$(curl -s -X POST "$APP_URL/api/bench/run" -H 'content-type: application/json' -H "origin: $APP_URL" \
    -d "{\"target\":\"$1\",\"scenario\":\"$2\",\"runs\":$3}") || die "Web アプリに接続できません（$APP_URL）"
  echo "$res" >>"$4"
  log "$1 $2 x$3: $(echo "$res" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);
    console.log((d.results||[]).map(r=>r.ok?"ok("+r.requests.map(q=>q.completionTokens).join("/")+")":"NG:"+r.error).join(" ")||s)}
    catch{console.log(s.slice(0,200))}})')"
}

measure() { # $1=target $2=jsonl  シナリオごとに必要な設定でサーバを起動してから測る
  local s runs
  for s in $SCENARIOS; do
    runs=$RUNS
    case "$s" in
      parallel4) # MacBook Air と同じ条件（llama-server は --parallel 4）
        runs=$P4_RUNS
        if [ "$1" = llamacpp ]; then start_llama 4 "$LLAMA_CTX" 0; else start_omlx; fi ;;
      parallel8 | parallel16 | mixed) # 共有サーバ設定
        if [ "$1" = llamacpp ]; then start_llama "$SHARED_SLOTS" "$SHARED_CTX" 1; else start_omlx "$SHARED_SLOTS"; fi ;;
      *) # MacBook Air と同じ条件
        if [ "$1" = llamacpp ]; then start_llama 2 "$LLAMA_CTX" 0; else start_omlx; fi ;;
    esac
    run_one "$1" "$s" "$runs" "$2"
  done
}

only_llama() { measure llamacpp "$1"; stop_server; }
only_omlx() { measure omlx "$1"; stop_server; }
cooldown() { log "休止 ${COOLDOWN} 秒"; sleep "$COOLDOWN"; }

# ---- 事前チェック ----
mkdir -p "$OUT"
[ -n "$LLAMA_MODEL" ] || die "LLAMA_MODEL に GGUF ファイルのパスを指定してください"
[ -f "$LLAMA_MODEL" ] || die "GGUF が見つかりません: $LLAMA_MODEL"
[ -x "$LLAMA_SERVER" ] || die "llama-server が見つかりません: $LLAMA_SERVER"
[ -x "$OMLX_CLI" ] || die "oMLX が見つかりません: $OMLX_CLI"
[ -d "$OMLX_MODEL_DIR" ] || die "oMLX のモデルフォルダがありません: $OMLX_MODEL_DIR"
for p in "$LLAMA_PORT" "$OMLX_PORT"; do
  port_busy "$p" && die "ポート $p が使用中です。常駐している推論サーバを止めてから実行してください"
done
curl -s -o /dev/null "$APP_URL/api/bench/status" || die "Web アプリが起動していません（npm run dev）"

# スリープ防止（このスクリプトが終わると自動で解除）
caffeinate -i -w $$ &

{
  echo "# 計測環境"
  echo "- 日時: $(date '+%Y-%m-%d %H:%M')"
  echo "- 機種: $(sysctl -n hw.model) / $(sysctl -n machdep.cpu.brand_string)"
  echo "- メモリ: $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
  echo "- macOS: $(sw_vers -productVersion)"
  echo "- llama.cpp: $("$LLAMA_SERVER" --version 2>&1 | grep -m1 version)"
  echo "- oMLX: $(defaults read "$(dirname "$(dirname "$OMLX_CLI")")/Info.plist" CFBundleShortVersionString 2>/dev/null || echo 不明)"
  echo "- GGUF: $(basename "$LLAMA_MODEL")（SHA256 $(shasum -a 256 "$LLAMA_MODEL" | cut -c1-16)…）"
  echo "- 条件: RUNS=$RUNS P4_RUNS=$P4_RUNS COOLDOWN=${COOLDOWN}s"
  echo "- 共有サーバ設定（parallel8 / parallel16 / mixed）: 同時処理数 ${SHARED_SLOTS}、llama-server -c ${SHARED_CTX} --kv-unified"
} >"$OUT/env.md"
log "計測開始。出力先: $OUT"

cooldown
log "[A] llama.cpp → oMLX"
only_llama "$OUT/A-llama-first.jsonl"
only_omlx "$OUT/A-llama-first.jsonl"

cooldown
log "[B] oMLX → llama.cpp"
only_omlx "$OUT/B-omlx-first.jsonl"
only_llama "$OUT/B-omlx-first.jsonl"

node scripts/summarize.mjs "$OUT" >"$OUT/summary.md"
log "完了。集計: $OUT/summary.md"
cat "$OUT/env.md" "$OUT/summary.md"
