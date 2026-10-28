const ALLOWED_HEADERS = ["content-type", "cache-control", "x-csrf-token"];

function dashboardOrigin(): URL | null {
  const value = process.env.JOBBER_API_ORIGIN;
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export async function proxyDashboardRequest(request: Request, path: string[]): Promise<Response> {
  const origin = dashboardOrigin();
  if (!origin) {
    return Response.json({ error: "dashboard_api_not_configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  if (path.some((segment) => !segment || segment === "." || segment === ".." || segment.length > 256)) {
    return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const target = new URL(`/${path.map(encodeURIComponent).join("/")}`, origin);
  target.search = new URL(request.url).search;
  const headers = new Headers();
  for (const name of ["content-type", "cookie", "x-csrf-token"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("origin", origin.origin);
  // Only an HTTPS request needs the trusted-proxy signal. On direct loopback
  // HTTP, sending any forwarded header makes the API correctly reject token
  // login as a spoofable transport.
  if (request.headers.get("x-forwarded-proto") === "https") headers.set("x-forwarded-proto", "https");

  const body = request.method === "GET" ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
    redirect: "manual",
  });

  const responseHeaders = new Headers();
  for (const name of ALLOWED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie?.() ?? []) responseHeaders.append("Set-Cookie", cookie);
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
