import { connection } from "next/server";
import { rejectCrossSite } from "@/lib/guard";
import { checkTarget, SCENARIOS, TARGETS, type TargetId } from "@/lib/bench";

export async function GET(request: Request) {
  await connection();
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const ids = Object.keys(TARGETS) as TargetId[];
  const checks = await Promise.all(ids.map((id) => checkTarget(id)));
  return Response.json({
    targets: ids.map((id, i) => ({
      id,
      label: TARGETS[id].label,
      baseUrl: TARGETS[id].baseUrl,
      model: TARGETS[id].model,
      ...checks[i],
    })),
    scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, ...s })),
  });
}
