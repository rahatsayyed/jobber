"use client";

import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

const THEME_KEY = "jobber-dashboard-theme";
type Theme = "dark" | "light";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(currentTheme()); // eslint-disable-line react-hooks/set-state-in-effect -- read the theme the head script chose, after hydration
    // With no saved choice the page follows the system setting, also while it is open.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      let saved: string | null = null;
      try { saved = window.localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
      if (saved === "dark" || saved === "light") return;
      const next: Theme = media.matches ? "dark" : "light";
      applyTheme(next);
      setTheme(next);
    };
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  function toggleTheme() {
    const nextTheme: Theme = theme === "light" ? "dark" : "light";
    applyTheme(nextTheme);
    setTheme(nextTheme);
    try {
      window.localStorage.setItem(THEME_KEY, nextTheme);
    } catch {
      // Theme selection remains available when browser storage is unavailable.
    }
  }

  const isDark = theme === "dark";

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={isDark}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? <MoonIcon size={16} weight="fill" aria-hidden="true" /> : <SunIcon size={16} weight="fill" aria-hidden="true" />}
      <span>{isDark ? "Dark" : "Light"}</span>
    </button>
  );
}
