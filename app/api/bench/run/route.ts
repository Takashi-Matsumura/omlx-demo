import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { isScenarioId, isTargetId, runScenario, TARGETS, type ScenarioResult } from "@/lib/bench";
import { rejectCrossSite } from "@/lib/guard";

// 計測は1本ずつ（同時に流すと測定値が崩れ、推論サーバの負荷も大きくなる）
let busy = false;

// ローカル計測専用のエンドポイント。接続先は lib/bench.ts で固定している。
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  if (busy) return Response.json({ error: "別の計測が実行中です" }, { status: 409 });
  busy = true;
  try {
    return await handle(request);
  } finally {
    busy = false;
  }
}

async function handle(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON を送ってください" }, { status: 400 });
  }
  const { target, scenario, runs } = (body ?? {}) as Record<string, unknown>;
  if (!isTargetId(target)) return Response.json({ error: "target が不正です" }, { status: 400 });
  if (!isScenarioId(scenario)) return Response.json({ error: "scenario が不正です" }, { status: 400 });
  const n = typeof runs === "number" && Number.isInteger(runs) ? Math.min(Math.max(runs, 1), 5) : 1;

  const results: ScenarioResult[] = [];
  for (let i = 0; i < n; i++) {
    // 2回目キャッシュの計測は、直前に同じ文書で初回を流してから測る
    if (scenario === "longCached") {
      const warm = await runScenario(target, "long");
      if (!warm.ok) {
        results.push({ ...warm, scenario });
        break;
      }
    }
    const r = await runScenario(target, scenario);
    results.push(r);
    if (!r.ok) break;
  }

  const record = {
    at: new Date().toISOString(),
    target,
    model: TARGETS[target].model,
    scenario,
    results,
  };
  const dir = path.join(process.cwd(), "bench-results");
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "results.jsonl"), JSON.stringify(record) + "\n");

  return Response.json(record);
}
