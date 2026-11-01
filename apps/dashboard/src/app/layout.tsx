import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", colorScheme: "light dark" };
export const metadata: Metadata = { title: "Jobber | Operator dashboard", description: "A local control surface for Jobber." };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script id="theme-preference">{`try { let t = null; try { t = localStorage.getItem("jobber-dashboard-theme"); } catch {} if (t !== "dark" && t !== "light") t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; document.documentElement.dataset.theme = t; } catch {}`}</script>
      </head>
      <body>{children}</body>
    </html>
  );
}
