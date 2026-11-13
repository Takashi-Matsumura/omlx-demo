// oMLX / llama.cpp の OpenAI 互換 API に対するベンチマーク計測（サーバ専用）。
// 接続先はここで固定し、クライアントから URL を受け取らない（SSRF 対策）。

export const TARGETS = {
  omlx: {
    label: "oMLX",
    baseUrl: process.env.OMLX_BASE_URL ?? "http://127.0.0.1:8000/v1",
    model: process.env.OMLX_MODEL ?? "gemma-4-12B-it-4bit",
    apiKey: process.env.OMLX_API_KEY,
    // oMLX の同時処理数は管理 API（要認証）からしか取れないため、既定値 8 を仮定する
    assumedSlots: Number(process.env.OMLX_MAX_CONCURRENT_REQUESTS ?? 8),
  },
  llamacpp: {
    label: "llama.cpp",
    baseUrl: process.env.LLAMACPP_BASE_URL ?? "http://127.0.0.1:8080/v1",
    model: process.env.LLAMACPP_MODEL ?? "gemma-4-12b-it-Q4_K_M.gguf",
    apiKey: process.env.LLAMACPP_API_KEY,
    assumedSlots: null, // /props の total_slots から取得する
  },
} as const;

export type TargetId = keyof typeof TARGETS;
export const isTargetId = (v: unknown): v is TargetId =>
  typeof v === "string" && Object.hasOwn(TARGETS, v);

export const SCENARIOS = {
  short: {
    label: "短いプロンプト",
    concurrency: 1,
    description: "約30トークンの質問に回答（生成速度の目安）",
  },
  long: {
    label: "長いプロンプト（初回）",
    concurrency: 1,
    description: "約4,000トークンの文書を要約（プリフィル速度の目安）",
  },
  longCached: {
    label: "長いプロンプト（2回目）",
    concurrency: 1,
    description: "直前と同じ文書に別の質問（プレフィックスキャッシュの効果）",
  },
  parallel: {
    label: "同時2リクエスト",
    concurrency: 2,
    description: "短いプロンプトを2本同時に送信（合計スループット）",
  },
  parallel4: {
    label: "同時4リクエスト",
    concurrency: 4,
    description: "短いプロンプトを4本同時に送信（合計スループット）",
  },
} as const;

export type ScenarioId = keyof typeof SCENARIOS;
export const isScenarioId = (v: unknown): v is ScenarioId =>
  typeof v === "string" && Object.hasOwn(SCENARIOS, v);

export type RequestMetrics = {
  ttftMs: number; // 最初のトークンが届くまで
  totalMs: number;
  promptTokens: number | null;
  completionTokens: number;
  decodeTps: number; // 生成速度（2トークン目以降）
  prefillTps: number | null; // プロンプト処理速度（promptTokens / ttft）
};

export type ScenarioResult = {
  target: TargetId;
  scenario: ScenarioId;
  ok: boolean;
  error?: string;
  requests: RequestMetrics[];
  wallMs: number;
  aggregateTps: number; // 全リクエストの生成トークン合計 / 経過時間
};

const MAX_TOKENS = 256;

// 再現性のため固定文書を生成（約4,000トークン）。初回と2回目で同じ文書を使う。
function longDocument(): string {
  const para = (i: number) =>
    `第${i}節。社内の開発チームは、ローカル環境で大規模言語モデルを動かす方法を検討している。` +
    `検討対象は推論エンジンの種類、量子化の方式、メモリ使用量、応答の速さ、運用のしやすさである。` +
    `節番号${i}では、評価用の端末で測った値と、導入時に気づいた点を記録する。` +
    `値は同じ条件で三回測り、中央値を採用した。条件をそろえるため、他のアプリはすべて終了している。`;
  return Array.from({ length: 40 }, (_, i) => para(i + 1)).join("\n");
}

// nonce をプロンプトの先頭に入れて、前の計測のプレフィックスキャッシュが効かないようにする。
// longCached は、直前の long と同じ nonce を使うことで「同じ文書の2回目」を作る。
function scenarioPrompts(scenario: ScenarioId, nonce: string): string[] {
  const head = `[計測ID ${nonce}]\n`;
  switch (scenario) {
    case "short":
      return [`${head}大規模言語モデルをローカルで動かす利点を、箇条書きで5つ挙げてください。`];
    case "long":
      return [`${head}次の文書を300字で要約してください。\n\n${longDocument()}`];
    case "longCached":
      return [`${head}次の文書を300字で要約してください。\n\n${longDocument()}\n\n追加の質問: 測定条件をどうそろえたかだけを答えてください。`];
    case "parallel":
    case "parallel4":
      return Array.from(
        { length: scenario === "parallel" ? 2 : 4 },
        (_, i) => `${head}ローカル LLM の活用例を1つ挙げ、${i + 2}文で説明してください。`,
      );
  }
}

async function measureOne(target: TargetId, prompt: string, signal: AbortSignal): Promise<RequestMetrics> {
  const t = TARGETS[target];
  const started = performance.now();
  const res = await fetch(`${t.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: t.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: MAX_TOKENS,
      // 出力の長さをそろえるため、終了トークンを無視して毎回 MAX_TOKENS まで生成させる
      // （oMLX・llama-server とも ignore_eos に対応）
      ignore_eos: true,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`${t.label}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  let firstTokenAt: number | null = null;
  let chunkTokens = 0;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  const decoder = new TextDecoder();
  let buf = "";

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: {
        choices?: { delta?: { content?: string; reasoning_content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;
      const delta = json.choices?.[0]?.delta;
      if (delta && (delta.content || delta.reasoning_content)) {
        firstTokenAt ??= performance.now();
        chunkTokens++;
      }
    }
  }

  const end = performance.now();
  const ttftMs = (firstTokenAt ?? end) - started;
  const totalMs = end - started;
  const completionTokens = usage?.completion_tokens ?? chunkTokens;
  const promptTokens = usage?.prompt_tokens ?? null;
  const decodeMs = totalMs - ttftMs;
  return {
    ttftMs,
    totalMs,
    promptTokens,
    completionTokens,
    decodeTps: decodeMs > 0 && completionTokens > 1 ? ((completionTokens - 1) / decodeMs) * 1000 : 0,
    prefillTps: promptTokens && ttftMs > 0 ? (promptTokens / ttftMs) * 1000 : null,
  };
}

// 接続エラーなどを、原因がわかる日本語に置き換える
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
  if (/ECONNREFUSED/.test(cause) || (msg === "fetch failed" && !cause)) {
    return "サーバに接続できません（起動していないか、ポート番号が違います）";
  }
  if (e instanceof Error && (e.name === "TimeoutError" || /timeout/i.test(msg))) {
    return "サーバの応答がありません（タイムアウト）";
  }
  if (msg === "fetch failed") return `サーバに接続できません（${cause}）`;
  return msg;
}

export async function runScenario(target: TargetId, scenario: ScenarioId, nonce: string): Promise<ScenarioResult> {
  const prompts = scenarioPrompts(scenario, nonce);
  const signal = AbortSignal.timeout(300_000);
  const started = performance.now();
  try {
    const requests = await Promise.all(prompts.map((p) => measureOne(target, p, signal)));
    const wallMs = performance.now() - started;
    const tokens = requests.reduce((s, r) => s + r.completionTokens, 0);
    return { target, scenario, ok: true, requests, wallMs, aggregateTps: (tokens / wallMs) * 1000 };
  } catch (e) {
    return {
      target,
      scenario,
      ok: false,
      error: friendlyError(e),
      requests: [],
      wallMs: performance.now() - started,
      aggregateTps: 0,
    };
  }
}

export type TargetStatus = {
  ok: boolean;
  models?: string[];
  modelFound?: boolean;
  slots?: number | null; // 同時に処理できるリクエスト数
  slotsSource?: "server" | "assumed";
  error?: string;
};

// llama-server の /props（OpenAI 互換 API の外側）から同時処理数を読む
async function llamaSlots(baseUrl: string, apiKey?: string): Promise<number | null> {
  try {
    const res = await fetch(new URL("/props", baseUrl), {
      signal: AbortSignal.timeout(3000),
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { total_slots?: unknown };
    return typeof json.total_slots === "number" ? json.total_slots : null;
  } catch {
    return null;
  }
}

export async function checkTarget(target: TargetId): Promise<TargetStatus> {
  const t = TARGETS[target];
  try {
    const res = await fetch(`${t.baseUrl}/models`, {
      signal: AbortSignal.timeout(3000),
      headers: t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {},
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `認証に失敗しました（HTTP ${res.status}。API キーを確認してください）` };
    }
    if (!res.ok) return { ok: false, error: `サーバがエラーを返しました（HTTP ${res.status}）` };
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = json.data?.map((m) => m.id) ?? [];
    // llama-server はモデル ID をファイルのフルパスで返すため、末尾一致でも可とする
    const modelFound = models.some((m) => m === t.model || m.endsWith(`/${t.model}`));
    if (t.assumedSlots != null) {
      return { ok: true, models, modelFound, slots: t.assumedSlots, slotsSource: "assumed" };
    }
    const slots = await llamaSlots(t.baseUrl, t.apiKey);
    return { ok: true, models, modelFound, slots, slotsSource: slots == null ? undefined : "server" };
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
}
