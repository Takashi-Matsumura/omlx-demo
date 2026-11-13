// /api/bench/* を、同じオリジンの画面からの JSON リクエストに限定する（CSRF 対策）。
// - Content-Type が application/json 以外 → 拒否。異なるオリジンからだとプリフライトが必要になり、
//   CORS ヘッダを返さないのでブラウザ側で止まる。
// - Sec-Fetch-Site / Origin が別オリジンを示す → 拒否。
// - Host / Origin のホスト名を許可リストと照合する（DNS リバインディング対策。
//   攻撃者ドメインを 127.0.0.1 に向けると Origin と Host が一致してしまうため、自己比較では防げない）。
const ALLOWED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  ...(process.env.BENCH_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
]);

function allowedHostname(hostHeader: string): boolean {
  try {
    return ALLOWED_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const forbidden = (error: string) => Response.json({ error }, { status: 403 });

export function rejectCrossSite(request: Request): Response | null {
  const host = request.headers.get("host");
  if (!host || !allowedHostname(host)) return forbidden("host not allowed");

  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return forbidden("cross-site request rejected");

  const origin = request.headers.get("origin");
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* 不正な Origin は拒否 */
    }
    if (!originHost || !allowedHostname(originHost) || originHost !== host) {
      return forbidden("cross-origin request rejected");
    }
  }
  if (request.method === "POST") {
    const ct = request.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) {
      return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
  }
  return null;
}
