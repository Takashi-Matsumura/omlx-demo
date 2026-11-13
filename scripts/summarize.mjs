// run-bench.sh の出力フォルダを集計し、Markdown の比較表を標準出力に書く。
//   node scripts/summarize.mjs bench-results/<フォルダ>
// 「先に測定」= oMLX は B（oMLX → llama.cpp）、llama.cpp は A（llama.cpp → oMLX）の値。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/summarize.mjs <run-bench の出力フォルダ>");
  process.exit(1);
}

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// 最近傍法の p95（多人数利用で「遅い方の利用者」がどれだけ待つかの目安）
const p95 = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};

function load(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const ok = (rec.results ?? []).filter((r) => r.ok);
    const reqs = ok.flatMap((r) => r.requests);
    const shortReqs = reqs.filter((q) => q.kind !== "long");
    const longReqs = reqs.filter((q) => q.kind === "long");
    out.set(`${rec.target}:${rec.scenario}`, {
      n: ok.length,
      failed: (rec.results ?? []).length - ok.length,
      ttftMs: median(reqs.map((q) => q.ttftMs)),
      ttftP95Ms: p95(reqs.map((q) => q.ttftMs)),
      shortTtftMs: median(shortReqs.map((q) => q.ttftMs)),
      shortTtftP95Ms: p95(shortReqs.map((q) => q.ttftMs)),
      longTtftMs: median(longReqs.map((q) => q.ttftMs)),
      prefillTps: median(reqs.map((q) => q.prefillTps).filter((v) => v != null)),
      decodeTps: median(reqs.map((q) => q.decodeTps)),
      aggregateTps: median(ok.map((r) => r.aggregateTps)),
    });
  }
  return out;
}

const A = load(path.join(dir, "A-llama-first.jsonl"));
const B = load(path.join(dir, "B-omlx-first.jsonl"));

const ROWS = [
  ["short", "decodeTps", "短いプロンプト: 生成速度（tok/s）", "high"],
  ["long", "prefillTps", "長いプロンプト: プロンプト処理（tok/s）", "high"],
  ["long", "ttftMs", "長いプロンプト: 最初のトークンまで（秒）", "low"],
  ["longCached", "ttftMs", "長いプロンプト（2回目）: 最初のトークンまで（秒）", "low"],
  ["parallel", "decodeTps", "同時2リクエスト: 1本あたりの生成速度（tok/s）", "high"],
  ["parallel", "aggregateTps", "同時2リクエスト: 合計スループット（tok/s）", "high"],
  ["parallel4", "aggregateTps", "同時4リクエスト: 合計スループット（tok/s）", "high"],
  ["parallel8", "aggregateTps", "同時8リクエスト: 合計スループット（tok/s）", "high"],
  ["parallel8", "decodeTps", "同時8リクエスト: 1本あたりの生成速度（tok/s）", "high"],
  ["parallel8", "ttftP95Ms", "同時8リクエスト: 最初のトークンまで p95（秒）", "low"],
  ["parallel16", "aggregateTps", "同時16リクエスト: 合計スループット（tok/s）", "high"],
  ["parallel16", "decodeTps", "同時16リクエスト: 1本あたりの生成速度（tok/s）", "high"],
  ["parallel16", "ttftP95Ms", "同時16リクエスト: 最初のトークンまで p95（秒）", "low"],
  ["mixed", "shortTtftMs", "混在負荷: 短い質問の最初のトークンまで 中央値（秒）", "low"],
  ["mixed", "shortTtftP95Ms", "混在負荷: 短い質問の最初のトークンまで p95（秒）", "low"],
  ["mixed", "longTtftMs", "混在負荷: 長文の最初のトークンまで 中央値（秒）", "low"],
  ["mixed", "aggregateTps", "混在負荷: 合計スループット（tok/s）", "high"],
];

const fmt = (v, key) =>
  v == null || Number.isNaN(v) ? "—" : key.endsWith("Ms") ? (v / 1000).toFixed(2) : v.toFixed(1);

function verdict(o, l, better) {
  if ([o, l].some((v) => v == null || Number.isNaN(v))) return "—";
  const ratio = better === "high" ? o / l : l / o; // >1 なら oMLX が速い
  if (ratio >= 1.1) return `oMLX（約${ratio.toFixed(1)}倍）`;
  if (ratio <= 1 / 1.1) return `llama.cpp（約${(1 / ratio).toFixed(1)}倍）`;
  return "同程度";
}

const lines = [
  "# 集計結果",
  "",
  "| シナリオ・指標 | oMLX 先に測定 | oMLX 後に測定 | llama.cpp 先に測定 | llama.cpp 後に測定 | 先に測った値での比較 |",
  "| --- | --- | --- | --- | --- | --- |",
];
for (const [scenario, key, label, better] of ROWS) {
  const oFirst = B.get(`omlx:${scenario}`)?.[key];
  const oLater = A.get(`omlx:${scenario}`)?.[key];
  const lFirst = A.get(`llamacpp:${scenario}`)?.[key];
  const lLater = B.get(`llamacpp:${scenario}`)?.[key];
  lines.push(
    `| ${label} | ${fmt(oFirst, key)} | ${fmt(oLater, key)} | ${fmt(lFirst, key)} | ${fmt(lLater, key)} | ${verdict(oFirst, lFirst, better)} |`,
  );
}
lines.push(
  "",
  "各値は中央値（p95 と書いたものを除く）。比較の判定は差が1割未満なら「同程度」。",
  "同時8・16リクエストと混在負荷は、両サーバとも同時処理数16の共有サーバ設定で測定（llama-server は --parallel 16 --kv-unified -c 65536）。",
);

const failures = [
  ...[...A].map(([k, v]) => [`A（llama.cpp → oMLX）${k}`, v]),
  ...[...B].map(([k, v]) => [`B（oMLX → llama.cpp）${k}`, v]),
].filter(([, v]) => v.failed > 0);
if (failures.length) {
  lines.push("", "## 失敗した計測", "");
  for (const [k, v] of failures) lines.push(`- ${k}: ${v.failed} 回失敗（成功 ${v.n} 回）`);
}
console.log(lines.join("\n"));
