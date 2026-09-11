import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Palette, RotateCcw } from 'lucide-react';

export type Theme = 'light' | 'dark' | 'system';

interface PaletteChoice {
  id: string;
  seed: string;
  tint: number;
}

// Keys and the palette shape are mirrored by the pre-paint script in
// index.html, which applies them before first paint so nothing flashes.
const THEME_KEY = 'ai-json-organizer:theme';
const PALETTE_KEY = 'ai-json-organizer:palette';

/**
 * Every colour in the app derives from one accent and one tint, so a palette is
 * just those two values. index.css fixes lightness per theme and caps chroma,
 * which is what makes it safe to let anyone pick any accent: it cannot come out
 * unreadable or neon.
 */
const PALETTES: ReadonlyArray<PaletteChoice & { label: string }> = [
  { id: 'slate', label: 'Slate', seed: '#4a7bd8', tint: 0.5 },
  { id: 'graphite', label: 'Graphite', seed: '#8a8f98', tint: 0 },
  { id: 'forest', label: 'Forest', seed: '#2f9e7e', tint: 0.5 },
  { id: 'rose', label: 'Rose', seed: '#d1567a', tint: 0.4 },
  { id: 'brass', label: 'Brass', seed: '#d0a253', tint: 0.8 },
];

const DEFAULT_PALETTE: PaletteChoice = { id: 'slate', seed: '#4a7bd8', tint: 0.5 };

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const HEX = /^#[0-9a-f]{6}$/i;

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // Private mode. Fall through to following the system.
  }
  return 'system';
}

function readPalette(): PaletteChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(PALETTE_KEY) ?? 'null');
    if (raw && HEX.test(raw.seed) && typeof raw.tint === 'number' && raw.tint >= 0 && raw.tint <= 1) {
      return { id: typeof raw.id === 'string' ? raw.id : 'custom', seed: raw.seed, tint: raw.tint };
    }
  } catch {
    // Unreadable or absent: the default applies.
  }
  return DEFAULT_PALETTE;
}

function applyTheme(theme: Theme) {
  const resolved =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

function applyPalette({ id, seed, tint }: PaletteChoice) {
  const root = document.documentElement;
  root.style.setProperty('--accent-seed', seed);
  root.style.setProperty('--tint', String(tint));
  root.setAttribute('data-palette', id);
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not worth failing over.
  }
}

/**
 * Theme and colour in one place. It replaces the old theme dropdown rather than
 * sitting beside it, so there is a single control for how the app looks.
 */
export function AppearanceMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [palette, setPalette] = useState<PaletteChoice>(readPalette);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyTheme(theme);
    save(THEME_KEY, theme);

    // Only while following the system does the OS flipping at dusk mean anything.
    if (theme !== 'system') return;
    const query = matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  useEffect(() => {
    applyPalette(palette);
    save(PALETTE_KEY, JSON.stringify(palette));
  }, [palette]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('input:checked')?.focus();

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Which swatch is lit follows the accent itself, so a custom pick that lands
  // on a preset's colour shows that preset rather than nothing.
  const preset = PALETTES.find(p => p.seed.toLowerCase() === palette.seed.toLowerCase());
  const tintLabel = palette.tint === 0 ? 'Neutral' : `${Math.round(palette.tint * 100)}%`;

  return (
    <div className="appearance">
      <button
        ref={triggerRef}
        type="button"
        className="appearance-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => setOpen(o => !o)}
      >
        <Palette className="appearance-trigger-icon" aria-hidden="true" />
        <span className="appearance-trigger-label">Appearance</span>
      </button>

      {open && (
        <div ref={panelRef} id={panelId} className="appearance-panel" role="dialog" aria-label="Appearance">
          <fieldset className="appearance-group">
            <legend className="appearance-legend">Theme</legend>
            <div className="appearance-segments">
              {THEMES.map(({ value, label }) => (
                <label key={value} className="appearance-segment">
                  <input
                    type="radio"
                    name="appearance-theme"
                    value={value}
                    checked={theme === value}
                    onChange={() => setTheme(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="appearance-group">
            <legend className="appearance-legend">Colour</legend>
            <div className="appearance-swatches">
              {PALETTES.map(p => (
                <label key={p.id} className="appearance-swatch">
                  <input
                    type="radio"
                    name="appearance-palette"
                    value={p.id}
                    checked={preset?.id === p.id}
                    onChange={() => setPalette({ id: p.id, seed: p.seed, tint: p.tint })}
                  />
                  <span
                    className="appearance-swatch-dot"
                    style={{ '--swatch-seed': p.seed } as CSSProperties}
                    aria-hidden="true"
                  />
                  <span className="appearance-swatch-name">{p.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="appearance-row">
            <label className="appearance-row-label" htmlFor={`${panelId}-accent`}>
              Custom accent
            </label>
            <div className="appearance-custom">
              <input
                id={`${panelId}-accent`}
                type="color"
                className="appearance-color"
                value={palette.seed}
                onChange={e => setPalette(p => ({ id: 'custom', seed: e.target.value, tint: p.tint }))}
              />
              <span className="appearance-hex">{palette.seed.toUpperCase()}</span>
            </div>
          </div>

          <div className="appearance-row">
            <label className="appearance-row-label" htmlFor={`${panelId}-tint`}>
              Background tint
            </label>
            <div className="appearance-tint">
              <input
                id={`${panelId}-tint`}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={palette.tint}
                onChange={e => setPalette(p => ({ ...p, tint: Number(e.target.value) }))}
              />
              <span className="appearance-tint-value">{tintLabel}</span>
            </div>
          </div>

          <button
            type="button"
            className="btn-secondary appearance-reset"
            onClick={() => {
              setTheme('system');
              setPalette(DEFAULT_PALETTE);
            }}
          >
            <RotateCcw className="btn-icon-sm" aria-hidden="true" />
            Reset to default
          </button>
        </div>
      )}
    </div>
  );
}
