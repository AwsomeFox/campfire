/**
 * Preferences — /preferences, available to every authenticated user.
 * Mirrors design/claude-design/Campfire.dc.html "Preferences" screen
 * (~L1156-1227): Theme card (accent swatches + free hex input, live preview)
 * and a display-name field. Only the fields with backing API (accentColor,
 * displayName — both on PreferencesUpdate) are wired up; the design's Text
 * size, AI scribe, and Notifications cards have no backing data yet, so they
 * render disabled with a "soon" tag rather than being silently dropped.
 */
import { useEffect, useState } from 'react';
import type { User } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, ErrorNote } from '../../components/ui';

// Swatch hexes converted from the design's accent palette (Campfire.dc.html
// `accents:` state — oklch(0.72 0.13 55) "ember", oklch(0.72 0.12 150) "moss",
// oklch(0.72 0.11 235) "tide") to #rrggbb, since PreferencesUpdate.accentColor
// is a strict hex regex and the design's tokens are OKLCH-only.
const ACCENT_SWATCHES: Array<{ name: string; hex: string }> = [
  { name: 'Nocturne', hex: '#9184d9' }, // server default (Nocturne blurple) — same as null
  { name: 'Ember', hex: '#e28d4f' },
  { name: 'Moss', hex: '#69ba7c' },
  { name: 'Tide', hex: '#57afe0' },
];

const DEFAULT_ACCENT = '#9184d9';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export default function PreferencesPage() {
  const { me, refresh } = useAuth();
  const user = me?.user ?? null;

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [accentColor, setAccentColor] = useState<string | null>(user?.accentColor ?? null);
  const [hexInput, setHexInput] = useState(user?.accentColor ?? '');
  const [hexError, setHexError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName ?? '');
    setAccentColor(user.accentColor ?? null);
    setHexInput(user.accentColor ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  if (!user) {
    return (
      <div className="w-full mx-auto px-5 pt-7 pb-12" style={{ maxWidth: 640 }}>
        <Card>
          <p className="text-muted" style={{ fontSize: 13 }}>Loading…</p>
        </Card>
      </div>
    );
  }

  const dirty = displayName !== (user.displayName ?? '') || accentColor !== (user.accentColor ?? null);
  const previewColor = accentColor ?? DEFAULT_ACCENT;

  function pickSwatch(hex: string) {
    // "Nocturne" swatch matches the server default — picking it clears the override (null),
    // same as any other value the user might want to reset to.
    const next = hex === DEFAULT_ACCENT ? null : hex;
    setAccentColor(next);
    setHexInput(next ?? '');
    setHexError(null);
  }

  function onHexChange(value: string) {
    setHexInput(value);
    if (value.trim() === '') {
      setAccentColor(null);
      setHexError(null);
      return;
    }
    const normalized = value.startsWith('#') ? value : `#${value}`;
    if (HEX_RE.test(normalized)) {
      setAccentColor(normalized);
      setHexError(null);
    } else {
      setHexError('Enter a 6-digit hex color, e.g. #9184d9.');
    }
  }

  async function save() {
    if (hexError) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.patch<User>(`${API}/me/preferences`, {
        displayName: displayName.trim(),
        accentColor,
      });
      setDisplayName(updated.displayName ?? '');
      setAccentColor(updated.accentColor ?? null);
      setHexInput(updated.accentColor ?? '');
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save preferences.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full mx-auto px-5 pt-7 pb-12 flex flex-col gap-3.5" style={{ maxWidth: 640 }}>
      <div>
        <h3 style={{ margin: '4px 0 0' }}>Preferences</h3>
        <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
          Yours alone — follows your account across campaigns and devices.
        </p>
      </div>

      {error && <ErrorNote message={error} />}

      <div className="card elev-sm">
        <span className="card-kicker">Theme</span>

        <div className="flex items-center gap-3 flex-wrap">
          <span style={{ flex: 1, minWidth: 120, fontSize: 13.5 }}>Accent</span>
          <div className="flex gap-2.5">
            {ACCENT_SWATCHES.map((sw) => {
              const active = (accentColor ?? DEFAULT_ACCENT) === sw.hex;
              return (
                <button
                  key={sw.hex}
                  type="button"
                  title={sw.name}
                  onClick={() => pickSwatch(sw.hex)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    border: `2px solid ${active ? 'var(--color-text)' : 'var(--color-divider)'}`,
                    background: sw.hex,
                    cursor: 'pointer',
                    boxShadow: active ? `0 0 0 3px color-mix(in srgb, ${sw.hex} 35%, transparent)` : 'none',
                    padding: 0,
                  }}
                />
              );
            })}
          </div>
        </div>

        <div className="field" style={{ maxWidth: 220 }}>
          <label htmlFor="prefs-hex">Custom hex</label>
          <input
            id="prefs-hex"
            className="input"
            value={hexInput}
            placeholder={DEFAULT_ACCENT}
            onChange={(e) => onHexChange(e.target.value)}
            style={{ fontFamily: 'ui-monospace, monospace' }}
          />
        </div>
        {hexError && <p className="text-sm" style={{ color: '#f87171' }}>{hexError}</p>}

        <div className="flex items-center gap-3">
          <span
            aria-hidden
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: previewColor,
              border: '1px solid var(--color-divider)',
              flex: 'none',
            }}
          />
          <span className="text-muted" style={{ fontSize: 12 }}>
            {accentColor ? `Live preview — ${accentColor}` : 'Live preview — server default (Nocturne)'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 120, fontSize: 13.5, color: 'var(--color-neutral-600)' }}>Text size</span>
          <div className="seg" style={{ opacity: 0.5 }}>
            <button type="button" disabled style={{ padding: '7px 14px', font: 'inherit', fontSize: 12.5, border: 0, background: 'transparent', minHeight: 36 }}>
              Default
            </button>
            <button type="button" disabled style={{ padding: '7px 14px', font: 'inherit', fontSize: 12.5, border: 0, background: 'transparent', minHeight: 36 }}>
              Large
            </button>
          </div>
          <span className="tag tag-neutral" style={{ fontSize: 9 }}>soon</span>
        </div>

        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          Accent recolors your view only — the table sees their own.
        </p>
      </div>

      <div className="card elev-sm">
        <span className="card-kicker">Profile</span>
        <div className="field">
          <label htmlFor="prefs-display-name">Display name</label>
          <input
            id="prefs-display-name"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={120}
          />
        </div>
      </div>

      <div className="card elev-sm" style={{ opacity: 0.6 }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="card-kicker" style={{ margin: 0 }}>AI scribe</span>
          <span className="tag tag-neutral" style={{ fontSize: 9 }}>soon</span>
        </div>
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          Connect your own AI over MCP. Not available yet — no backing API on this server.
        </p>
      </div>

      <div className="card elev-sm" style={{ opacity: 0.6 }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="card-kicker" style={{ margin: 0 }}>Notifications</span>
          <span className="tag tag-neutral" style={{ fontSize: 9 }}>soon</span>
        </div>
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          Session reminders, inbox replies, and quest updates. Not available yet — no backing API on this server.
        </p>
      </div>

      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" disabled={saving || !dirty || !!hexError} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
      </div>
    </div>
  );
}
