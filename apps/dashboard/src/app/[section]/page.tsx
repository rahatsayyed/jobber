import { DashboardShell } from "@/components/dashboard/dashboard-shell";

// The route reads URL-specific data only to select a fully client-rendered workspace.
// Keep the App Router cache-components transition explicit until individual views gain
// their own static shells.
export const instant = false;

export default async function WorkspacePage({ params }: PageProps<"/[section]">) {
  const { section } = await params;
  return <DashboardShell section={section} />;
}
