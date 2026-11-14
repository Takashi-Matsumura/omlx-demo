# 別の Mac で同じ条件の計測をする手順

MacBook Air（Apple M5・32GB）で行った oMLX と llama.cpp の比較を、別の Mac（例: Mac Studio M4 Max）でも同じ条件で行うための手順です。Claude Code に任せる場合は、このファイルを読ませてから依頼してください（末尾に依頼文の例があります）。

## 1. そろえる条件

| 項目 | 値 |
| --- | --- |
| oMLX | v0.7.3（GitHub Releases の dmg 版） |
| llama.cpp | 0.9.0（build 12110, commit cd959bae9）。違う版になった場合は、結果の `env.md` に記録される版を報告に書く |
| モデル（oMLX） | [mlx-community/gemma-4-12B-it-4bit](https://huggingface.co/mlx-community/gemma-4-12B-it-4bit) |
| モデル（llama.cpp） | `gemma-4-12b-it-Q4_K_M.gguf`（MacBook Air と同じファイルをコピーして使う） |
| llama-server の引数 | `-ngl 999 -c 32768 --flash-attn on --cache-reuse 256 --parallel 2`（同時4リクエストのときだけ `--parallel 4`） |
| oMLX の引数 | `--paged-ssd-cache-dir ~/.omlx/cache --paged-ssd-cache-max-size 30GB` |
| 計測 | 片方のサーバだけを動かす。両方の順番で測る（A: llama.cpp → oMLX、B: oMLX → llama.cpp）。各周の前に5分休止 |
| リクエスト | 温度 0、出力は `ignore_eos` で毎回 256 トークン |

サーバの引数と計測の手順は `scripts/run-bench.sh` に組み込んであるので、手で合わせる必要はありません。

### ファイルのハッシュ（SHA256）

| ファイル | SHA256 |
| --- | --- |
| `oMLX-0.7.3-macos26-27.dmg` | `2acfde41aeac0b022dbca803ca109437f3ccaf0c33f3415881526b985bee86f2` |
| `model-00001-of-00002.safetensors`（MLX） | `0d58feed0c98a69c07317b4481aeae5ab2785f12a496ea96ab24c4842808de78` |
| `model-00002-of-00002.safetensors`（MLX） | `5b00a1bcb596ce6e827b4cdea6ecf2a0f35bb01306eb87c1ea4b3bcde36c7755` |
| `gemma-4-12b-it-Q4_K_M.gguf` | `43fec98c5102b1c446b4ddd0a9439f1db3a2e1f2e0b8cd143ce1ea619a9403d6` |

macOS 15 用の dmg（`oMLX-0.7.3-macos15-sequoia.dmg`）のハッシュは、次のコマンドで Releases の記載を確認します。

```bash
gh api repos/jundot/omlx/releases/tags/v0.7.3 --jq '.assets[] | .name + " " + .digest'
```

## 2. 準備

### oMLX

1. OS に合う dmg を [v0.7.3 のリリース](https://github.com/jundot/omlx/releases/tag/v0.7.3) からダウンロードし、`shasum -a 256` で上の値と照合する。
2. `oMLX.app` を `/Applications` にコピーし、`spctl -a -vv /Applications/oMLX.app` で `source=Notarized Developer ID` と出ることを確認する。
3. メニューバーのアプリからはサーバを起動しない（計測スクリプトがサーバを起動するため）。

### llama.cpp

```bash
brew install llama.cpp   # 入っていない場合
llama-server --version   # 版を控える
```

### モデル

```bash
# MLX 版（hf コマンドは huggingface_hub に含まれる。Xet 転送が止まることがあったため HTTP で取得する）
HF_HUB_DISABLE_XET=1 hf download mlx-community/gemma-4-12B-it-4bit \
  --local-dir ~/.omlx/models/mlx-community/gemma-4-12B-it-4bit
shasum -a 256 ~/.omlx/models/mlx-community/gemma-4-12B-it-4bit/*.safetensors
```

GGUF は MacBook Air から AirDrop などでコピーし、`shasum -a 256` で上の値と照合します。

### 常駐サーバを止める

8000 番と 8080 番を使う推論サーバ（launchd、メニューバーアプリなど）が動いていると、計測スクリプトは止まります。先に止めてください。

```bash
lsof -nP -iTCP:8000 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

## 3. 計測

```bash
git clone https://github.com/Takashi-Matsumura/omlx-demo.git
cd omlx-demo
npm install
npx next dev -H 127.0.0.1    # 別のターミナルで起動したままにする

LLAMA_MODEL=/path/to/gemma-4-12b-it-Q4_K_M.gguf scripts/run-bench.sh
```

- スクリプトが推論サーバを片方ずつ起動・停止し、両方の順番で全シナリオを測ります。終了時（中断時も）にはサーバを止めます。
- 計測中は `caffeinate` でスリープを防ぎます。他の重いアプリは閉じておいてください。
- MacBook Air では休止を含めて約1時間かかりました。

主な設定（環境変数）:

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `LLAMA_MODEL` | なし（必須） | GGUF のパス |
| `LLAMA_MMPROJ` | なし | mmproj のパス（MacBook Air では読み込んでいた。速度への影響はない想定） |
| `OMLX_MODEL_DIR` | `~/.omlx/models` | oMLX のモデルフォルダ |
| `RUNS` / `P4_RUNS` | `3` / `5` | 通常シナリオ / 同時4リクエストの繰り返し回数 |
| `COOLDOWN` | `300` | 各周の前の休止秒数 |
| `SCENARIOS` | 全シナリオ | 例: `"short long"` で一部だけ測る |
| `SHARED_SLOTS` / `SHARED_CTX` | `16` / `65536` | 多人数シナリオでの同時処理数と、llama-server の KV 全体の長さ |

### 多人数シナリオ（共有サーバの想定）

複数人で1台のサーバを使う場合を想定し、次の3つのシナリオも測ります。両サーバとも、同時処理数16の共有サーバ設定で起動し直してから測ります。

| シナリオ | 内容 | サーバの設定 |
| --- | --- | --- |
| `parallel8` / `parallel16` | 短いプロンプトを8本・16本同時に送信 | llama-server: `--parallel 16 --kv-unified -c 65536`、oMLX: `--max-concurrent-requests 16` |
| `mixed` | 長文の要約2本の0.5秒後に短い質問6本を送信 | 同上 |

- `summary.md` には、最初のトークンまでの時間の p95（遅い方の利用者がどれだけ待つか）も出ます。
- llama-server は `--parallel` を明示すると KV を各スロットに分けるため（1本あたり `-c` ÷ スロット数）、`--kv-unified` を付けないと同時16本では長いプロンプトが入りません。

## 4. 結果

`bench-results/<ホスト名>-<日時>/` に次のファイルができます。

| ファイル | 内容 |
| --- | --- |
| `env.md` | 機種・メモリ・macOS・各ソフトの版・GGUF のハッシュ |
| `summary.md` | 比較表（oMLX は B、llama.cpp は A の「先に測った値」どうしで比較） |
| `A-llama-first.jsonl` / `B-omlx-first.jsonl` | 生データ |
| `run.log`, `llama-server.log`, `omlx.log` | 実行ログ |

`summary.md` は `node scripts/summarize.mjs <フォルダ>` で作り直せます。
なお、Web アプリの API も同じ結果を `bench-results/results.jsonl` に追記します（集計には使いません）。

### 読むときの注意

- 「先に測定」と「後に測定」の差が大きい場合は、熱の影響が残っています。休止を延ばして測り直してください。
- 判定は1回の計測の中央値で決めています。MacBook Air では、llama.cpp の同時2リクエストの値が回によって大きくぶれました。差が小さい項目は、もう一度測って同じ傾向が出るか確かめてください。

## 5. Claude Code への依頼文の例

```
docs/benchmark-runbook.md を読んで、この Mac で oMLX と llama.cpp の計測をしてください。
GGUF は ~/Downloads/gemma-4-12b-it-Q4_K_M.gguf に置きました。
インストールやモデルのダウンロード、常駐サーバの停止が必要なときは、実行する前に確認してください。
終わったら env.md と summary.md の内容を報告してください。
```
