/**
 * Preferences — /preferences, available to every authenticated user.
 * Mirrors design/claude-design/Campfire.dc.html "Preferences" screen
 * (~L1156-1227): Theme card (accent swatches + free hex input, live preview),
 * text size (default/large — persisted as PreferencesUpdate.textSize, applied
 * globally by AuthProvider via data-text-size on <html>), and a display-name
 * field. The design's Notifications card was removed rather than shipped as a
 * dead placeholder — notifications are their own larger feature (issue #6).
 * The AI scribe card is live — MCP is a real, shipped API (see /tokens +
 * apps/mcp) — so it links to token creation instead of claiming "not
 * available".
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TextSize, User } from '@campfire/schema';
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
  const mcpUrl = `${window.location.origin}/mcp`;

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [accentColor, setAccentColor] = useState<string | null>(user?.accentColor ?? null);
  const [textSize, setTextSize] = useState<TextSize>(user?.textSize ?? 'default');
  const [hexInput, setHexInput] = useState(user?.accentColor ?? '');
  const [hexError, setHexError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName ?? '');
    setAccentColor(user.accentColor ?? null);
    setTextSize(user.textSize ?? 'default');
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

  const dirty =
    displayName !== (user.displayName ?? '') ||
    accentColor !== (user.accentColor ?? null) ||
    textSize !== (user.textSize ?? 'default');
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
        textSize,
      });
      setDisplayName(updated.displayName ?? '');
      setAccentColor(updated.accentColor ?? null);
      setTextSize(updated.textSize ?? 'default');
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
          <span style={{ flex: 1, minWidth: 120, fontSize: 13.5 }}>Text size</span>
          <div className="seg">
            {(['default', 'large'] as const).map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => setTextSize(size)}
                className="seg-opt"
                style={
                  textSize === size
                    ? { color: 'var(--color-accent)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' }
                    : undefined
                }
              >
                {size === 'default' ? 'Default' : 'Large'}
              </button>
            ))}
          </div>
        </div>

        <p className="text-muted" style={{ margin: 0, fontSize: 11.5 }}>
          Accent and text size restyle your view only — the table sees their own.
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

      <div className="card elev-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="card-kicker" style={{ margin: 0 }}>Connect an AI (MCP)</span>
          <span className="tag tag-accent" style={{ fontSize: 9 }}>live</span>
        </div>
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          Point Claude (or any MCP client) at this server to read and write your campaigns — 36+ tools covering
          quests, NPCs, characters, encounters, dice and more.
        </p>
        <div className="cf-inset" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="text-muted" style={{ fontSize: 11 }}>MCP endpoint</span>
          <code style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
            {mcpUrl}
          </code>
        </div>
        <div className="flex gap-2 items-center">
          <Link to="/tokens" className="btn btn-primary" style={{ fontSize: 12.5 }}>
            Create an API token
          </Link>
          <span className="text-muted" style={{ fontSize: 11.5 }}>then connect from the tokens page</span>
        </div>
      </div>

      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" disabled={saving || !dirty || !!hexError} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
      </div>

      <DeleteAccountCard username={user.username} />
    </div>
  );
}

/**
 * Self-delete (issue #128 player data rights): a type-to-confirm danger action
 * that deletes the signed-in user's own account (DELETE /me). The server cascades
 * sessions/tokens/memberships, de-links (keeps) owned character sheets, and
 * refuses (409) if you're the last admin or the sole DM of a campaign — the copy
 * points you at the fix rather than dead-ending.
 */
function DeleteAccountCard({ username }: { username: string }) {
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmText.trim() === username;

  async function remove() {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await api.delete(`${API}/me`);
      // Session is already cleared server-side; logout() resets client state and
      // routes back to the login screen.
      await logout();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete your account.");
      setDeleting(false);
    }
  }

  return (
    <div className="card elev-sm" style={{ borderLeft: '2px solid #f87171' }}>
      <span className="card-kicker" style={{ color: '#f87171' }}>Delete account</span>
      {!open ? (
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
            Permanently deletes your account and its sessions and tokens. Character sheets you own stay in their
            campaigns (un-owned); notes you wrote stay too. This cannot be undone.
          </p>
          <div className="flex-1" />
          <button className="btn btn-ghost" style={{ fontSize: 12.5, color: '#f87171' }} onClick={() => setOpen(true)}>
            Delete my account…
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-neutral-200)' }}>
            Type your username <strong>{username}</strong> to confirm.
          </p>
          <input
            className="input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={username}
            autoComplete="off"
          />
          {error && <p className="text-sm" style={{ color: '#f87171' }}>{error}</p>}
          <div className="flex gap-2 items-center">
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12.5 }}
              onClick={() => {
                setOpen(false);
                setConfirmText('');
                setError(null);
              }}
              disabled={deleting}
            >
              Cancel
            </button>
            <div className="flex-1" />
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12.5, color: '#f87171', borderColor: '#f87171' }}
              disabled={!canDelete || deleting}
              onClick={remove}
            >
              {deleting ? 'Deleting…' : 'Delete my account'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
