import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

// Kept in step with the pre-paint script in index.html.
const KEY = 'ai-json-organizer:theme';

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'Match system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // Private mode. Fall through to following the system.
  }
  return 'system';
}

function apply(theme: Theme) {
  const resolved =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

/**
 * A labelled control rather than a sun/moon switch. The icon toggle is the
 * default every interface reaches for, and it hides the third option this app
 * actually has: following the system.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Not worth failing over.
    }

    // Only while following the system does the OS flipping at dusk mean anything.
    if (theme !== 'system') return;
    const query = matchMedia('(prefers-color-scheme: light)');
    const onChange = () => apply('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  return (
    <div className="theme-toggle">
      <label className="theme-label" htmlFor="theme-select">
        Theme
      </label>
      <select
        id="theme-select"
        className="theme-select"
        value={theme}
        onChange={e => setTheme(e.target.value as Theme)}
      >
        {OPTIONS.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
