"use client";

import { useCallback, useEffect, useState } from "react";

type Target = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  ok: boolean;
  models?: string[];
  modelFound?: boolean;
  error?: string;
};
type Scenario = { id: string; label: string; description: string };
type RequestMetrics = {
  ttftMs: number;
  totalMs: number;
  promptTokens: number | null;
  completionTokens: number;
  decodeTps: number;
  prefillTps: number | null;
};
type ScenarioResult = {
  ok: boolean;
  error?: string;
  requests: RequestMetrics[];
  wallMs: number;
  aggregateTps: number;
};
type RunRecord = { at: string; target: string; model: string; scenario: string; results: ScenarioResult[] };

type Summary = { ttftMs: number; decodeTps: number; aggregateTps: number; prefillTps: number | null; n: number };

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function summarize(rec: RunRecord | undefined): Summary | null {
  if (!rec) return null;
  const ok = rec.results.filter((r) => r.ok);
  if (ok.length === 0) return null;
  const reqs = ok.flatMap((r) => r.requests);
  const prefill = reqs.map((r) => r.prefillTps).filter((v): v is number => v != null);
  return {
    ttftMs: median(reqs.map((r) => r.ttftMs)),
    decodeTps: median(reqs.map((r) => r.decodeTps)),
    aggregateTps: median(ok.map((r) => r.aggregateTps)),
    prefillTps: prefill.length ? median(prefill) : null,
    n: ok.length,
  };
}

const METRICS: { key: keyof Omit<Summary, "n">; label: string; unit: string; better: "high" | "low" }[] = [
  { key: "ttftMs", label: "最初のトークンまで", unit: "ms", better: "low" },
  { key: "prefillTps", label: "プロンプト処理", unit: "tok/s", better: "high" },
  { key: "decodeTps", label: "生成速度（1本あたり）", unit: "tok/s", better: "high" },
  { key: "aggregateTps", label: "合計スループット", unit: "tok/s", better: "high" },
];

const fmt = (v: number | null | undefined, unit: string) =>
  v == null || Number.isNaN(v) ? "—" : unit === "ms" ? `${Math.round(v).toLocaleString()} ms` : `${v.toFixed(1)} tok/s`;

export default function BenchApp() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [runs, setRuns] = useState(3);
  const [records, setRecords] = useState<Record<string, RunRecord>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/bench/status", { cache: "no-store" });
      const json = await res.json();
      setTargets(json.targets);
      setScenarios(json.scenarios);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    // 初回表示時に接続先の状態を取得する
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function runAll() {
    setError(null);
    for (const t of targets.filter((t) => t.ok)) {
      for (const s of scenarios) {
        setRunning(`${t.label} / ${s.label}`);
        try {
          const res = await fetch("/api/bench/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: t.id, scenario: s.id, runs }),
          });
          const rec = (await res.json()) as RunRecord;
          setRecords((prev) => ({ ...prev, [`${t.id}:${s.id}`]: rec }));
        } catch (e) {
          setError(`${t.label} / ${s.label}: ${String(e)}`);
        }
      }
    }
    setRunning(null);
  }

  function download() {
    const blob = new Blob([JSON.stringify(Object.values(records), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bench-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const ready = targets.some((t) => t.ok);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">oMLX vs llama.cpp ベンチマーク</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        同じモデル（Gemma 4 12B・4bit 相当）を両方のサーバで動かし、OpenAI 互換 API 経由で速度を比べます。温度 0・出力は毎回 256 トークンに固定（ignore_eos）。
      </p>

      <section className="mt-8 grid gap-3 sm:grid-cols-2">
        {targets.map((t) => (
          <div key={t.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <span className="font-medium">{t.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${t.ok ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"}`}
              >
                {t.ok ? "接続OK" : "未接続"}
              </span>
            </div>
            <dl className="mt-2 space-y-0.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
              <div>{t.baseUrl}</div>
              <div>model: {t.model}</div>
              {!t.ok && <div className="text-red-600 dark:text-red-400">{t.error}</div>}
              {t.ok && t.modelFound === false && (
                <div className="text-amber-600">サーバのモデル一覧に {t.model} がありません: {t.models?.join(", ")}</div>
              )}
            </dl>
          </div>
        ))}
      </section>

      <section className="mt-6 flex flex-wrap items-center gap-3">
        <label className="text-sm">
          繰り返し回数{" "}
          <select
            className="ml-1 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            value={runs}
            onChange={(e) => setRuns(Number(e.target.value))}
            disabled={!!running}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          onClick={runAll}
          disabled={!ready || !!running}
        >
          {running ? "計測中…" : "全シナリオを計測"}
        </button>
        <button className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700" onClick={refresh} disabled={!!running}>
          接続を再確認
        </button>
        <button
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-zinc-700"
          onClick={download}
          disabled={Object.keys(records).length === 0}
        >
          結果を JSON で保存
        </button>
        {running && <span className="text-sm text-zinc-500">実行中: {running}</span>}
      </section>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <section className="mt-8 space-y-6">
        {scenarios.map((s) => {
          const sums = targets.map((t) => ({ t, sum: summarize(records[`${t.id}:${s.id}`]), rec: records[`${t.id}:${s.id}`] }));
          return (
            <div key={s.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <h2 className="font-medium">{s.label}</h2>
              <p className="text-xs text-zinc-500">{s.description}</p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {METRICS.map((m) => {
                  const vals = sums.map(({ sum }) => (sum ? sum[m.key] : null));
                  const max = Math.max(...vals.map((v) => v ?? 0), 0);
                  const present = vals.filter((v): v is number => v != null && !Number.isNaN(v));
                  const best = present.length > 1 ? (m.better === "high" ? Math.max(...present) : Math.min(...present)) : null;
                  return (
                    <div key={m.key}>
                      <div className="text-xs text-zinc-500">
                        {m.label}（{m.better === "high" ? "大きいほど速い" : "小さいほど速い"}）
                      </div>
                      {sums.map(({ t, rec }, i) => {
                        const v = vals[i];
                        const failed = rec && rec.results.every((r) => !r.ok);
                        return (
                          <div key={t.id} className="mt-1 flex items-center gap-2 text-sm">
                            <span className="w-20 shrink-0">{t.label}</span>
                            <div className="h-3 flex-1 rounded bg-zinc-100 dark:bg-zinc-800">
                              {v != null && max > 0 && (
                                <div
                                  className={`h-3 rounded ${t.id === "omlx" ? "bg-sky-500" : "bg-orange-500"}`}
                                  style={{ width: `${(v / max) * 100}%` }}
                                />
                              )}
                            </div>
                            <span className={`w-28 shrink-0 text-right font-mono text-xs ${v === best ? "font-bold" : ""}`}>
                              {failed ? "失敗" : fmt(v, m.unit)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              {sums.some(({ rec }) => rec?.results.some((r) => !r.ok)) && (
                <ul className="mt-2 text-xs text-red-600">
                  {sums.flatMap(({ t, rec }) =>
                    (rec?.results ?? []).filter((r) => !r.ok).map((r, i) => <li key={`${t.id}${i}`}>{t.label}: {r.error}</li>),
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </section>
      <p className="mt-6 text-xs text-zinc-500">各値は繰り返し計測の中央値です。結果はサーバ側の bench-results/results.jsonl にも追記されます。</p>
    </main>
  );
}
