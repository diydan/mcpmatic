import { useEffect, useState } from "react";
import { applyTheme, readTheme, toggleTheme, type Theme } from "../lib/theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const initial = readTheme();
    applyTheme(initial);
    setTheme(initial);
  }, []);

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme((t) => toggleTheme(t))}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
