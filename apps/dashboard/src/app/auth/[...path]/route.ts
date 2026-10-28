import { proxyDashboardRequest } from "@/lib/dashboard-proxy";

export async function GET(request: Request, context: RouteContext<"/auth/[...path]">) {
  return proxyDashboardRequest(request, ["auth", ...(await context.params).path]);
}

export async function POST(request: Request, context: RouteContext<"/auth/[...path]">) {
  return proxyDashboardRequest(request, ["auth", ...(await context.params).path]);
}
