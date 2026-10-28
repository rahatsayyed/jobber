import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { redirect } from "next/navigation";

// OAuth root callbacks carry query parameters. This route must be rendered at
// request time rather than prerendered so those callbacks reach the API proxy.
export const instant = false;

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  // Some Google Desktop clients only accept a loopback root callback. Preserve
  // that supported shape while handing the actual exchange to the protected API.
  if (typeof params.code === "string" && typeof params.state === "string") {
    const callback = new URLSearchParams({ code: params.code, state: params.state });
    if (typeof params.scope === "string") callback.set("scope", params.scope);
    redirect(`/auth/callback?${callback.toString()}`);
  }
  if (typeof params.error === "string") {
    const callback = new URLSearchParams({ error: params.error });
    if (typeof params.error_description === "string") callback.set("error_description", params.error_description);
    redirect(`/auth/callback?${callback.toString()}`);
  }
  return <DashboardShell section="overview" />;
}
