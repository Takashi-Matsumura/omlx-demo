// /api/bench/* を、同じオリジンの画面からの JSON リクエストに限定する（CSRF 対策）。
// - Content-Type が application/json 以外 → 拒否。異なるオリジンからだとプリフライトが必要になり、
//   CORS ヘッダを返さないのでブラウザ側で止まる。
// - Sec-Fetch-Site / Origin が別オリジンを示す → 拒否。
export function rejectCrossSite(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return Response.json({ error: "cross-site request rejected" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("host");
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* 不正な Origin は下で拒否 */
    }
    if (!host || originHost !== host) {
      return Response.json({ error: "cross-origin request rejected" }, { status: 403 });
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
