import { proxyDashboardRequest } from "@/lib/dashboard-proxy";

export async function GET(request: Request, context: RouteContext<"/api/[...path]">) {
  return proxyDashboardRequest(request, (await context.params).path);
}

export async function POST(request: Request, context: RouteContext<"/api/[...path]">) {
  return proxyDashboardRequest(request, (await context.params).path);
}
