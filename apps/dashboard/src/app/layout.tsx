import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Jobber | Operator dashboard", description: "A local control surface for Jobber." };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script id="theme-preference">{`try { const savedTheme = localStorage.getItem("jobber-dashboard-theme"); if (savedTheme === "dark" || savedTheme === "light") document.documentElement.dataset.theme = savedTheme; } catch {}`}</script>
      </head>
      <body>{children}</body>
    </html>
  );
}
