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
    setTheme(currentTheme());
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
