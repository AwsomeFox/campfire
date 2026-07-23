/**
 * Preferences — /preferences, available to every authenticated user.
 * Mirrors design/claude-design/Campfire.dc.html "Preferences" screen
 * (~L1156-1227): Theme card (accent swatches + free hex input, live preview),
 * semantic reading mode (persisted as the backwards-compatible
 * PreferencesUpdate.textSize field and applied by AuthProvider), and a display-name
 * field. The design's Notifications card was removed rather than shipped as a
 * dead placeholder — notifications are their own larger feature (issue #6).
 * The AI scribe card is live — MCP is a real, shipped API (see /tokens +
 * apps/mcp) — so it links to token creation instead of claiming "not
 * available".
 *
 * Issue #795 — custom accent safety: drafting a hex builds a full tonal ramp
 * with contrast repair, previews real button/link/chip/focus/hover/selected
 * states immediately, and commits only via explicit Apply (Cancel restores the
 * prior theme; Reset returns to the Nocturne default).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import type { TextSize, User } from '@campfire/schema';
import { api, ApiError, API } from '../../lib/api';
import {
  localeController,
  isSupportedLanguage,
  SUPPORTED_LANGUAGES,
  SYSTEM_LOCALE,
  type LocalePreference,
} from '../../i18n';
import { useAuth } from '../../app/auth';
import {
  applyAccentColor,
  buildAccentPalette,
  DEFAULT_ACCENT,
  normalizeHex,
  paletteToCssVars,
} from '../../app/accentPalette';
import { Card, ErrorNote } from '../../components/ui';
import { PageTitle } from '../../components/PageTitle';

// Swatch hexes converted from the design's accent palette (Campfire.dc.html
// `accents:` state — oklch(0.72 0.13 55) "ember", oklch(0.72 0.12 150) "moss",
// oklch(0.72 0.11 235) "tide") to #rrggbb, since PreferencesUpdate.accentColor
// is a strict hex regex and the design's tokens are OKLCH-only.
const ACCENT_SWATCHES: Array<{ name: string; hex: string }> = [
  { name: 'Nocturne', hex: DEFAULT_ACCENT }, // server default (Nocturne blurple) — same as null
  { name: 'Ember', hex: '#e28d4f' },
  { name: 'Moss', hex: '#69ba7c' },
  { name: 'Tide', hex: '#57afe0' },
];

const READING_MODES = ['default', 'comfortable', 'large'] as const satisfies readonly TextSize[];

export default function PreferencesPage() {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const user = me?.user ?? null;
  const mcpUrl = `${window.location.origin}/mcp`;
  const [lang, setLang] = useState<LocalePreference>(() => localeController.preference);

  useEffect(() => localeController.subscribe(() => setLang(localeController.preference)), []);

  function changeLanguage(next: string) {
    if (next !== SYSTEM_LOCALE && !isSupportedLanguage(next)) return;
    const preference: LocalePreference = next;
    setLang(preference);
    localeController.setPreference(preference);
  }

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [accentColor, setAccentColor] = useState<string | null>(user?.accentColor ?? null);
  const [appliedAccent, setAppliedAccent] = useState<string | null>(user?.accentColor ?? null);
  const [textSize, setTextSize] = useState<TextSize>(user?.textSize ?? 'default');
  const [hexInput, setHexInput] = useState(user?.accentColor ?? '');
  const [hexError, setHexError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applyingAccent, setApplyingAccent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [accentSaved, setAccentSaved] = useState(false);
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accentSavedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName ?? '');
    setAccentColor(user.accentColor ?? null);
    setAppliedAccent(user.accentColor ?? null);
    setTextSize(user.textSize ?? 'default');
    setHexInput(user.accentColor ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => () => {
    if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
    if (accentSavedFlashTimerRef.current) clearTimeout(accentSavedFlashTimerRef.current);
  }, []);

  const draftPalette = useMemo(() => {
    // null draft = Nocturne default — still build a palette so the preview panel
    // shows default states even when the document still carries a prior override.
    const seed = accentColor === null ? DEFAULT_ACCENT : normalizeHex(accentColor);
    if (!seed) return null;
    return buildAccentPalette(seed);
  }, [accentColor]);

  const previewVars = useMemo(() => {
    if (!draftPalette) return undefined;
    return paletteToCssVars(draftPalette) as CSSProperties;
  }, [draftPalette]);

  if (!user) {
    return (
      <div className="w-full mx-auto px-5 pt-7 pb-12" style={{ maxWidth: 640 }}>
        <Card>
          <p className="text-muted" style={{ fontSize: 13 }}>{t('common.loading')}</p>
        </Card>
      </div>
    );
  }

  const profileDirty =
    displayName !== (user.displayName ?? '') ||
    textSize !== (user.textSize ?? 'default');
  const accentDirty = accentColor !== appliedAccent;
  const previewSeed = accentColor ?? DEFAULT_ACCENT;

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
    const normalized = normalizeHex(value);
    if (normalized) {
      setAccentColor(normalized);
      setHexError(null);
    } else {
      setHexError(t('preferences.hexError'));
    }
  }

  function cancelAccent() {
    setAccentColor(appliedAccent);
    setHexInput(appliedAccent ?? '');
    setHexError(null);
    applyAccentColor(appliedAccent);
  }

  function resetAccent() {
    setAccentColor(null);
    setHexInput('');
    setHexError(null);
  }

  async function applyAccent() {
    if (hexError) return;
    setApplyingAccent(true);
    setError(null);
    setAccentSaved(false);
    try {
      const updated = await api.patch<User>(`${API}/me/preferences`, {
        accentColor,
      });
      const next = updated.accentColor ?? null;
      setAccentColor(next);
      setAppliedAccent(next);
      setHexInput(next ?? '');
      applyAccentColor(next);
      await refresh();
      setAccentSaved(true);
      if (accentSavedFlashTimerRef.current) clearTimeout(accentSavedFlashTimerRef.current);
      accentSavedFlashTimerRef.current = setTimeout(() => setAccentSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('preferences.saveError'));
      applyAccentColor(appliedAccent);
    } finally {
      setApplyingAccent(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.patch<User>(`${API}/me/preferences`, {
        displayName: displayName.trim(),
        textSize,
      });
      setDisplayName(updated.displayName ?? '');
      setTextSize(updated.textSize ?? 'default');
      await refresh();
      setSaved(true);
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
      savedFlashTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('preferences.saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full mx-auto px-5 pt-7 pb-12 flex flex-col gap-3.5" style={{ maxWidth: 640 }}>
      <div>
        <PageTitle>{t('preferences.title')}</PageTitle>
        <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
          {t('preferences.subtitle')}
        </p>
      </div>

      {error && <ErrorNote message={error} />}

      <div className="card elev-sm">
        <span className="card-kicker">{t('preferences.theme')}</span>

        <div className="flex items-center gap-3 flex-wrap">
          <span style={{ flex: 1, minWidth: 120, fontSize: 13.5 }}>{t('preferences.accent')}</span>
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
          <label htmlFor="prefs-hex">{t('preferences.customHex')}</label>
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

        <div
          className="cf-inset accent-state-preview"
          data-testid="accent-state-preview"
          style={{
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            ...(previewVars ?? {}),
          }}
        >
          <span className="card-kicker">{t('preferences.accentPreview')}</span>
          <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
            {accentColor
              ? draftPalette?.repaired
                ? t('preferences.accentPreviewRepaired', { color: previewSeed, applied: draftPalette.accent })
                : t('preferences.livePreview', { color: accentColor })
              : t('preferences.livePreviewDefault')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="accent-preview-link"
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--color-accent)',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              {t('preferences.accentPreviewLink')}
            </button>
            <button type="button" className="btn btn-primary" data-testid="accent-preview-button">
              {t('preferences.accentPreviewButton')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="accent-preview-hover"
              style={{
                // Forced hover sample: tint + lighter accent text so the demo
                // stays WCAG AA (real :hover is transient; axe always sees this).
                background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                color: 'var(--color-accent-300)',
              }}
            >
              {t('preferences.accentPreviewHover')}
            </button>
            <span className="tag tag-accent" data-testid="accent-preview-chip">
              {t('preferences.accentPreviewChip')}
            </span>
            <span
              data-testid="accent-preview-selected"
              style={{
                fontSize: 12.5,
                padding: '4px 10px',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-accent-300)',
                boxShadow: 'inset 0 0 0 1px var(--color-accent)',
                background: 'color-mix(in srgb, var(--color-accent) 9%, transparent)',
              }}
            >
              {t('preferences.accentPreviewSelected')}
            </span>
            <span
              data-testid="accent-preview-focus"
              style={{
                fontSize: 12.5,
                padding: '4px 10px',
                borderRadius: 'var(--radius-sm)',
                outline: '2px solid var(--color-accent)',
                outlineOffset: 2,
              }}
            >
              {t('preferences.accentPreviewFocus')}
            </span>
          </div>
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          <button
            type="button"
            className="btn btn-primary"
            disabled={applyingAccent || !accentDirty || !!hexError}
            onClick={applyAccent}
            data-testid="accent-apply"
          >
            {applyingAccent ? t('preferences.applying') : t('preferences.applyAccent')}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={applyingAccent || !accentDirty}
            onClick={cancelAccent}
            data-testid="accent-cancel"
          >
            {t('preferences.cancelAccent')}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={applyingAccent || accentColor === null}
            onClick={resetAccent}
            data-testid="accent-reset"
          >
            {t('preferences.resetAccent')}
          </button>
          {accentSaved && <span className="text-muted" style={{ fontSize: 12 }}>{t('preferences.accentApplied')}</span>}
        </div>

        <fieldset className="reading-preference-fieldset" aria-describedby="reading-mode-help">
          <legend>{t('preferences.readingMode')}</legend>
          <div className="reading-options">
            {READING_MODES.map((mode) => (
              <label key={mode} className="reading-option">
                <input
                  type="radio"
                  name="reading-mode"
                  value={mode}
                  checked={textSize === mode}
                  onChange={() => setTextSize(mode)}
                />
                <span>
                  <strong>{t(`preferences.textSize${mode[0].toUpperCase()}${mode.slice(1)}`)}</strong>
                  <small>{t(`preferences.textSize${mode[0].toUpperCase()}${mode.slice(1)}Description`)}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div
          className="cf-inset reading-preview"
          data-preview-reading-mode={textSize}
          data-testid="reading-preview"
          style={{ padding: '12px 14px' }}
        >
          <span className="card-kicker">{t('preferences.readingPreview')}</span>
          <p>{t('preferences.readingPreviewText')}</p>
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {t('preferences.readingPreviewAnnouncement', { mode: t(`preferences.textSize${textSize[0].toUpperCase()}${textSize.slice(1)}`) })}
          </span>
        </div>

        <p id="reading-mode-help" className="text-muted reading-supporting" style={{ margin: 0 }}>
          {t('preferences.themeNote')}
        </p>
      </div>

      <div className="card elev-sm">
        <span className="card-kicker">{t('preferences.language')}</span>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="prefs-lang">{t('preferences.languageLabel')}</label>
          <select
            id="prefs-lang"
            className="input"
            value={lang}
            onChange={(e) => changeLanguage(e.target.value)}
          >
            <option value={SYSTEM_LOCALE}>{t('preferences.languageSystem')}</option>
            {SUPPORTED_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <p className="text-muted reading-supporting" style={{ margin: 0 }}>
          {t('preferences.languageNote')}
        </p>
      </div>

      <div className="card elev-sm">
        <span className="card-kicker">{t('preferences.profile')}</span>
        <div className="field">
          <label htmlFor="prefs-display-name">{t('preferences.displayName')}</label>
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
          <span className="card-kicker" style={{ margin: 0 }}>{t('preferences.mcpTitle')}</span>
          <span className="tag tag-accent">{t('preferences.mcpLive')}</span>
        </div>
        <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
          {t('preferences.mcpBlurb')}
        </p>
        <div className="cf-inset" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="text-muted" style={{ fontSize: 'var(--type-meta)' }}>{t('preferences.mcpEndpoint')}</span>
          <code style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
            {mcpUrl}
          </code>
        </div>
        <div className="flex gap-2 items-center">
          <Link to="/tokens" className="btn btn-primary" style={{ fontSize: 12.5 }}>
            {t('preferences.mcpCreateToken')}
          </Link>
          <span className="text-muted" style={{ fontSize: 'var(--type-meta)' }}>{t('preferences.mcpThenConnect')}</span>
        </div>
      </div>

      <div className="flex gap-2 items-center">
        <button className="btn btn-primary" disabled={saving || !profileDirty} onClick={save}>
          {saving ? t('preferences.saving') : t('preferences.save')}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 12 }}>{t('preferences.saved')}</span>}
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
  const { t } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t('preferences.deleteError'));
      setDeleting(false);
    }
  }

  return (
    <div className="card elev-sm" style={{ borderLeft: '2px solid #f87171' }}>
      <span className="card-kicker" style={{ color: '#f87171' }}>{t('preferences.deleteAccount')}</span>
      {!open ? (
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
            {t('preferences.deleteBlurb')}
          </p>
          <div className="flex-1" />
          <button className="btn btn-ghost btn-danger" style={{ fontSize: 12.5 }} onClick={() => setOpen(true)}>
            {t('preferences.deleteMyAccountEllipsis')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-neutral-200)' }}>
            <Trans
              i18nKey="preferences.deleteConfirmPrompt"
              values={{ username }}
              components={[<strong key="u" />]}
            />
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
              {t('preferences.cancel')}
            </button>
            <div className="flex-1" />
            <button
              className="btn btn-danger"
              style={{ fontSize: 12.5 }}
              disabled={!canDelete || deleting}
              aria-busy={deleting || undefined}
              onClick={remove}
            >
              {deleting ? t('preferences.deleting') : t('preferences.deleteMyAccount')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
