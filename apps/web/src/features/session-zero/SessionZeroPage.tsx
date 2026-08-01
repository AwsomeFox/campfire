import { useTranslation } from 'react-i18next';
/**
 * Session zero / table charter — issue #122.
 *
 * Session zero is where a table agrees on the content it will and won't play through
 * and the safety tools it will use in the moment. Before this, none of that had a home;
 * lines & veils lived (if anywhere) in a markdown blob players might never open. This
 * page is the "shared table memory": lines (hard limits), veils (soft limits), the
 * safety tools in use, house rules, and tone/content expectations. The whole table can
 * read it; the DM authors it. It's also exposed read-only over MCP so a connected AI DM
 * is bound by the same boundaries the humans agreed to.
 *
 * Route (wired in app/router.tsx):
 *   /c/:campaignId/session-zero  →  features/session-zero/SessionZeroPage.tsx (default export)
 *
 * Data:
 *   GET/PUT  /api/v1/campaigns/:campaignId/session-zero
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { ParticipantSupportPreference, SessionZero, SupportPreferenceVisibility } from '@campfire/schema';
import { api, API, ApiError, isStaleWrite, translateApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useProtectedForm } from '../../lib/useProtectedForm';
import {
  isSessionZeroCharterDirty,
  sessionZeroCharterDraftsEqual,
  type SessionZeroCharterDraft,
} from './sessionZeroFormState';
import { Markdown } from '../../components/Markdown';
import { Field } from '../../components/Field';
import {
  SESSION_ZERO_FIELD,
  SESSION_ZERO_PREFIX,
  SESSION_ZERO_SUPPORT_HELP,
  SESSION_ZERO_SUPPORT_LABEL,
} from '../../components/formFieldLabels';
import { Card, Skeleton, ErrorNote, EmptyState, Btn } from '../../components/ui';
import { PageTitle } from '../../components/PageTitle';
import { TermHelp } from '../../components/TermHelp';
import { StaleWriteConflict, type ConflictField } from '../../components/StaleWriteConflict';
import { RevisionHistoryPanel } from '../../components/RevisionHistoryPanel';
import { CharterConsentPanel } from './CharterConsentPanel';

type Draft = SessionZeroCharterDraft;

interface SupportDraft {
  supportText: string;
  visibility: SupportPreferenceVisibility;
  aiUseConsent: boolean;
}

const EMPTY_CHARTER_DRAFT: Draft = {
  lines: [],
  veils: [],
  safetyTools: [],
  houseRules: '',
  toneAndExpectations: '',
};

const EMPTY_SUPPORT_DRAFT: SupportDraft = {
  supportText: '',
  visibility: 'facilitator',
  aiUseConsent: false,
};

const CONFLICT_FIELDS: Array<ConflictField<Draft>> = [
  { key: 'lines', label: 'Lines', merge: true },
  { key: 'veils', label: 'Veils', merge: true },
  { key: 'safetyTools', label: 'Safety tools', merge: true },
  { key: 'houseRules', label: 'House rules', merge: true },
  { key: 'toneAndExpectations', label: 'Tone & expectations', merge: true },
];

function draftFrom(c: SessionZero): Draft {
  return {
    lines: [...c.lines],
    veils: [...c.veils],
    safetyTools: [...c.safetyTools],
    houseRules: c.houseRules,
    toneAndExpectations: c.toneAndExpectations,
  };
}

// Trim, drop blanks — the API rejects empty-string array entries, and blank rows are
// just editing scratch space.
function cleanList(items: string[]): string[] {
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

function isEmptyCharter(c: SessionZero): boolean {
  return (
    c.lines.length === 0 &&
    c.veils.length === 0 &&
    c.safetyTools.length === 0 &&
    c.houseRules.trim() === '' &&
    c.toneAndExpectations.trim() === ''
  );
}

export default function SessionZeroPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { me } = useAuth();
  const { isDm, canDmWrite } = useCampaignAccess();

  const [charter, setCharter] = useState<SessionZero | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [ownSupport, setOwnSupport] = useState<ParticipantSupportPreference | null>(null);
  const [visibleSupports, setVisibleSupports] = useState<ParticipantSupportPreference[]>([]);
  const [supportDraft, setSupportDraft] = useState<SupportDraft>(EMPTY_SUPPORT_DRAFT);
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportMessage, setSupportMessage] = useState<string | null>(null);
  const [confirmDeleteSupport, setConfirmDeleteSupport] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseDraft, setBaseDraft] = useState<Draft | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ base: Draft; theirs: Draft } | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const clearPersistedDraftRef = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const [c, own, visible] = await Promise.all([
        api.get<SessionZero>(`${API}/campaigns/${cid}/session-zero`),
        api.get<ParticipantSupportPreference | null>(`${API}/campaigns/${cid}/session-zero/support-preferences/me`),
        isDm
          ? api
              .get<{ campaignId: number; entries: ParticipantSupportPreference[] }>(
                `${API}/campaigns/${cid}/session-zero/support-preferences/summary`,
              )
              .then((res) => res.entries)
          : api.get<ParticipantSupportPreference[]>(`${API}/campaigns/${cid}/session-zero/support-preferences`),
      ]);
      if (sequence !== loadSequence.current) return;
      setCharter(c);
      setOwnSupport(own ?? null);
      setVisibleSupports(visible);
      setSupportDraft(
        own
          ? { supportText: own.supportText, visibility: own.visibility, aiUseConsent: own.aiUseConsent }
          : EMPTY_SUPPORT_DRAFT,
      );
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setForbidden(true);
      else setError(t('sessionZero.errors.load'));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [cid, isDm]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  useEffect(() => {
    const refreshAfterResume = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', refreshAfterResume);
    return () => document.removeEventListener('visibilitychange', refreshAfterResume);
  }, [load]);

  const startEdit = () => {
    if (!charter) return;
    const next = draftFrom(charter);
    setDraft(next);
    setBaseDraft(next);
    setExpectedUpdatedAt(charter.updatedAt);
    setConflict(null);
    setEditing(true);
    setActionError(null);
  };

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.put<SessionZero>(`${API}/campaigns/${cid}/session-zero`, {
        lines: cleanList(draft.lines),
        veils: cleanList(draft.veils),
        safetyTools: cleanList(draft.safetyTools),
        houseRules: draft.houseRules,
        toneAndExpectations: draft.toneAndExpectations,
        expectedUpdatedAt: expectedUpdatedAt ?? undefined,
      });
      setCharter(updated);
      setEditing(false);
      setDraft(null);
      setBaseDraft(null);
      setConflict(null);
      setHistoryNonce((value) => value + 1);
      clearPersistedDraftRef.current();
      return true;
    } catch (err) {
      if (isStaleWrite(err)) {
        try {
          const latest = await api.get<SessionZero>(`${API}/campaigns/${cid}/session-zero`);
          const theirs = draftFrom(latest);
          setConflict({ base: baseDraft ?? draft, theirs });
          setBaseDraft(theirs);
          setExpectedUpdatedAt(latest.updatedAt);
          setCharter(latest);
        } catch {
          setActionError(t('sessionZero.charterStale'));
        }
      } else {
        setActionError(t('sessionZero.errors.save'));
      }
      return false;
    } finally {
      setBusy(false);
    }
  }, [baseDraft, cid, draft, expectedUpdatedAt]);

  const charterBaseline = baseDraft ?? (charter ? draftFrom(charter) : EMPTY_CHARTER_DRAFT);
  const charterDraft = draft ?? charterBaseline;
  const charterDirty = editing && draft != null && baseDraft != null && isSessionZeroCharterDirty(draft, baseDraft);

  const protectedCharter = useProtectedForm({
    formId: 'session-zero-charter',
    userId: me?.user.id,
    campaignId: cid,
    active: editing && draft != null,
    dirty: charterDirty,
    draft: charterDraft,
    baseline: charterBaseline,
    serverUpdatedAt: expectedUpdatedAt ?? charter?.updatedAt ?? null,
    isDraftEqual: sessionZeroCharterDraftsEqual,
    onRestoreDraft: (restored) => setDraft(restored),
    onDiscard: () => {
      setEditing(false);
      setDraft(null);
      setBaseDraft(null);
      setConflict(null);
    },
    onSave: save,
  });
  clearPersistedDraftRef.current = protectedCharter.clearPersistedDraft;

  const saveSupport = async () => {
    setSupportBusy(true);
    setSupportMessage(null);
    try {
      const saved = await api.put<ParticipantSupportPreference>(
        `${API}/campaigns/${cid}/session-zero/support-preferences/me`,
        supportDraft,
      );
      setOwnSupport(saved);
      setSupportDraft({
        supportText: saved.supportText,
        visibility: saved.visibility,
        aiUseConsent: saved.aiUseConsent,
      });
      setVisibleSupports((rows) => [...rows.filter((row) => row.id !== saved.id), saved]);
      setSupportMessage('Your support preference was saved.');
    } catch (e) {
      setSupportMessage(translateApiError(e, t, { fallbackKey: 'sessionZero.errors.saveSupport' }));
    } finally {
      setSupportBusy(false);
    }
  };

  const deleteSupport = async () => {
    setSupportBusy(true);
    setSupportMessage(null);
    try {
      await api.delete<void>(`${API}/campaigns/${cid}/session-zero/support-preferences/me`);
      const deletedId = ownSupport?.id;
      setOwnSupport(null);
      setVisibleSupports((rows) => rows.filter((row) => row.id !== deletedId));
      setSupportDraft(EMPTY_SUPPORT_DRAFT);
      setConfirmDeleteSupport(false);
      setSupportMessage('Your support preference was deleted.');
    } catch (e) {
      setSupportMessage(translateApiError(e, t, { fallbackKey: 'sessionZero.errors.deleteSupport' }));
    } finally {
      setSupportBusy(false);
    }
  };

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={t('common.noCampaign')} />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <EmptyState icon="padlock" title={t('sessions.accessDenied')} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 pb-20 md:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PageTitle>{t('sessionZero.title')}</PageTitle>
        <TermHelp termId="sessionZero" />
        <div style={{ flex: 1 }} />
        {canDmWrite && !editing && !loading && (
          <Btn onClick={startEdit} style={{ fontSize: 13 }}>
            Edit charter
          </Btn>
        )}
      </div>

      <p className="text-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        The table's shared agreement on content and safety — lines &amp; veils, the safety tools you'll use, house
        rules, and the tone you're playing in. Everyone at the table can read this{isDm ? '; only the DM edits it.' : '.'}
      </p>

      {actionError && <ErrorNote message={actionError} />}
      {error && <ErrorNote message={error} onRetry={load} />}
      {protectedCharter.restorePrompt}
      {protectedCharter.leavePrompt}

      {loading && !charter ? (
        <Card density="compact" elev="sm">
          <Skeleton lines={6} />
        </Card>
      ) : editing && draft ? (
        <CharterForm draft={draft} setDraft={setDraft} />
      ) : charter && isEmptyCharter(charter) ? (
        <EmptyState
          icon="life-buoy"
          title={t('sessionZero.empty.title')}
          hint={isDm ? t('sessionZero.empty.hintDm') : t('sessionZero.empty.hintPlayer')}
        />
      ) : charter ? (
        <CharterView charter={charter} />
      ) : null}

      {editing && draft && (
        <>
          {conflict && (
            <StaleWriteConflict
              base={conflict.base}
              mine={draft}
              theirs={conflict.theirs}
              fields={CONFLICT_FIELDS}
              onResolve={(key, value) => setDraft((current) => current ? { ...current, [key]: value } : current)}
              onReloadAll={() => {
                setDraft(conflict.theirs);
                setBaseDraft(conflict.theirs);
                setConflict(null);
              }}
            />
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {protectedCharter.saveStatusLabel ? (
              <span className="text-xs text-slate-400" role="status" aria-live="polite">
                {protectedCharter.saveStatusLabel}
              </span>
            ) : null}
            <div style={{ flex: 1 }} />
            <Btn onClick={() => void save()} disabled={busy}>{conflict ? 'Save resolution' : 'Save charter'}</Btn>
            <Btn
              ghost
              onClick={() => {
                protectedCharter.clearPersistedDraft();
                setEditing(false);
                setDraft(null);
                setBaseDraft(null);
                setConflict(null);
              }}
              disabled={busy}
            >
              Cancel
            </Btn>
          </div>
        </>
      )}

      {/*
        Issue #600 — versions and the consent gate. Shown to EVERY member, not just the
        DM: the whole point is that a participant can see which version the table is
        operating under and answer the one awaiting them. The DM additionally gets the
        publish control and the outstanding list from inside the panel.
      */}
      {!loading && !editing && cid !== null && (
        <CharterConsentPanel campaignId={cid} isDm={isDm} onPublished={() => void load()} />
      )}

      {isDm && charter && !editing && (
        <RevisionHistoryPanel
          entityType="session_zero"
          entityId={cid}
          currentSnapshot={{
            lines: charter.lines.join('\n'),
            veils: charter.veils.join('\n'),
            safetyTools: charter.safetyTools.join('\n'),
            houseRules: charter.houseRules,
            toneAndExpectations: charter.toneAndExpectations,
          }}
          expectedUpdatedAt={charter.updatedAt}
          reloadNonce={historyNonce}
          onRestored={() => { setHistoryNonce((value) => value + 1); void load(); }}
          label="Charter history"
        />
      )}

      {!loading && (
        <section
          aria-labelledby="access-support-heading"
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div style={{ marginTop: 10 }}>
            <h2 id="access-support-heading" style={{ margin: 0, fontSize: '1.12rem' }}>Access support</h2>
            <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.5 }}>
              Optional practical preferences that help participation. No diagnosis or explanation is needed, and sharing
              is never required. You own your submission and can change or delete it at any time.
            </p>
          </div>

          <SupportSummary entries={visibleSupports} facilitator={isDm} />

          <Section
            title="Your support preference"
            hint="Examples include extra processing time, explicit turn cues, breaks, reading support, motion limits, or avoiding timers."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field
                idPrefix={SESSION_ZERO_PREFIX}
                name={SESSION_ZERO_FIELD.supportText}
                as="textarea"
                label={SESSION_ZERO_SUPPORT_LABEL}
                labelClassName=""
                value={supportDraft.supportText}
                onChange={(e) => setSupportDraft({ ...supportDraft, supportText: e.target.value })}
                help={SESSION_ZERO_SUPPORT_HELP}
                placeholder="For example: Give me a moment to answer after asking what my character does."
                rows={4}
                maxLength={2000}
                minHeight={96}
                optional
              />

              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontSize: 13, fontWeight: 600 }}>Who can read this?</legend>
                <p className="text-muted" style={{ fontSize: 11, margin: '2px 0 8px' }}>
                  This choice controls people at the table. AI use is a separate choice below.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                    <input
                      type="radio"
                      name="support-visibility"
                      value="facilitator"
                      checked={supportDraft.visibility === 'facilitator'}
                      onChange={() => setSupportDraft({ ...supportDraft, visibility: 'facilitator' })}
                    />
                    <span><strong>Facilitators only</strong><br /><span className="text-muted">Visible to campaign DMs for prep and live play.</span></span>
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                    <input
                      type="radio"
                      name="support-visibility"
                      value="table"
                      checked={supportDraft.visibility === 'table'}
                      onChange={() => setSupportDraft({ ...supportDraft, visibility: 'table' })}
                    />
                    <span><strong>Entire table</strong><br /><span className="text-muted">Visible to every campaign member.</span></span>
                  </label>
                </div>
              </fieldset>

              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={supportDraft.aiUseConsent}
                  onChange={(e) => setSupportDraft({ ...supportDraft, aiUseConsent: e.target.checked })}
                />
                <span>
                  <strong>Allow Campfire AI features to use this preference</strong><br />
                  <span className="text-muted">
                    Off by default. This is independent of who at the table can read it. Turning it off stops future AI disclosure immediately.
                  </span>
                </span>
              </label>

              {supportMessage && <div role="status" aria-live="polite" style={{ fontSize: 13 }}>{supportMessage}</div>}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Btn onClick={saveSupport} disabled={supportBusy || supportDraft.supportText.trim() === ''}>
                  {ownSupport ? 'Save changes' : 'Save preference'}
                </Btn>
                {ownSupport && !confirmDeleteSupport && (
                  <Btn ghost danger onClick={() => setConfirmDeleteSupport(true)} disabled={supportBusy}>Delete my submission</Btn>
                )}
                {confirmDeleteSupport && (
                  <div role="group" aria-label="Confirm support preference deletion" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Btn danger onClick={deleteSupport} disabled={supportBusy}>Confirm delete</Btn>
                    <Btn ghost onClick={() => setConfirmDeleteSupport(false)} disabled={supportBusy}>Keep it</Btn>
                  </div>
                )}
              </div>
            </div>
          </Section>
        </section>
      )}
    </div>
  );
}

function SupportSummary({ entries, facilitator }: { entries: ParticipantSupportPreference[]; facilitator: boolean }) {
  const visible = facilitator ? entries : entries.filter((entry) => entry.visibility === 'table');
  const tableCount = entries.filter((e) => e.visibility === 'table').length;
  const facilitatorOnlyCount = entries.filter((e) => e.visibility === 'facilitator').length;
  const aiConsentedCount = entries.filter((e) => e.aiUseConsent).length;

  return (
    <Section
      title={facilitator ? 'Facilitator prep / live summary' : 'Table-shared support'}
      hint={
        facilitator
          ? 'A concise view of what participants authorized facilitators to read. AI access remains separately consented.'
          : 'Only preferences participants chose to share with the entire table.'
      }
    >
      {facilitator && entries.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          <span className="tag">Total responses: {entries.length}</span>
          <span className="tag">Table shared: {tableCount}</span>
          <span className="tag">Facilitator only: {facilitatorOnlyCount}</span>
          <span className="tag tag-accent">AI consented: {aiConsentedCount}</span>
        </div>
      )}
      {visible.length === 0 ? (
        <span className="text-muted" style={{ fontStyle: 'italic', fontSize: 13 }}>
          No preferences shared for this view.
        </span>
      ) : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 10, listStyle: 'none', margin: 0, padding: 0 }}>
          {visible.map((entry) => (
            <li key={entry.id} style={{ fontSize: 13 }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong>{entry.ownerName || 'Participant'}</strong>
                <span className="text-muted">{entry.visibility === 'table' ? 'Entire table' : 'Facilitators only'}</span>
                {facilitator && (
                  <span className={`text-xs ${entry.aiUseConsent ? 'text-emerald-400' : 'text-slate-400'}`}>
                    · {entry.aiUseConsent ? 'AI consented' : 'AI opted out'}
                  </span>
                )}
              </div>
              <div style={{ marginTop: 3, whiteSpace: 'pre-wrap' }}>{entry.supportText}</div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card density="compact" elev="sm">
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 500 }}>{title}</div>
      {hint && <div className="text-muted" style={{ fontSize: 11, marginTop: 2 }}>{hint}</div>}
      <div style={{ marginTop: 10 }}>{children}</div>
    </Card>
  );
}

function ChipList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <span className="text-muted" style={{ fontStyle: 'italic', fontSize: 13 }}>None recorded.</span>;
  }
  return (
    <ul style={{ display: 'flex', flexDirection: 'column', gap: 6, listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((item, i) => (
        <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}>
          <span aria-hidden style={{ color: 'var(--color-accent)' }}>•</span>
          <span style={{ minWidth: 0 }}>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function CharterView({ charter }: { charter: SessionZero }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Section title={t('sessionZero.charter.lines.title')} hint={t('sessionZero.charter.lines.hint')}>
        <ChipList items={charter.lines} />
      </Section>
      <Section title={t('sessionZero.charter.veils.title')} hint={t('sessionZero.charter.veils.hint')}>
        <ChipList items={charter.veils} />
      </Section>
      <Section title={t('sessionZero.charter.safetyTools.title')} hint={t('sessionZero.charter.safetyTools.hint')}>
        <ChipList items={charter.safetyTools} />
        {/* #599 — the charter records the tools a table AGREED to use; this points at the one
            Campfire actually implements, so "X-Card" here stops being a word nobody can act on. */}
        <p className="text-muted">{t('sessionZero.charter.safetyTools.builtIn')}</p>
      </Section>
      {charter.houseRules.trim() !== '' && (
        <Section title={t('sessionZero.charter.houseRules.title')}>
          <Markdown>{charter.houseRules}</Markdown>
        </Section>
      )}
      {charter.toneAndExpectations.trim() !== '' && (
        <Section title={t('sessionZero.charter.tone.title')}>
          <Markdown>{charter.toneAndExpectations}</Markdown>
        </Section>
      )}
    </div>
  );
}

// A simple newline-per-entry editor for a string list — one line/veil/tool per row.
function ListEditor({
  name,
  label,
  help,
  placeholder,
  items,
  onChange,
}: {
  name: string;
  label: string;
  help: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <Field
      idPrefix={SESSION_ZERO_PREFIX}
      name={name}
      as="textarea"
      label={label}
      help={help}
      value={items.join('\n')}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.split('\n'))}
      rows={4}
      minHeight={96}
      optional
    />
  );
}

function CharterForm({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft | null) => void }) {
  const { t } = useTranslation();
  return (
    <Card
      density="compact" elev="sm"
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      data-testid="session-zero-charter-form"
    >
      <ListEditor
        name={SESSION_ZERO_FIELD.lines}
        label={t('sessionZero.charter.lines.formLabel')}
        help={t('sessionZero.charter.lines.formHelp')}
        placeholder={t('sessionZero.charter.lines.placeholder')}
        items={draft.lines}
        onChange={(lines) => setDraft({ ...draft, lines })}
      />
      <ListEditor
        name={SESSION_ZERO_FIELD.veils}
        label={t('sessionZero.charter.veils.formLabel')}
        help={t('sessionZero.charter.veils.formHelp')}
        placeholder={t('sessionZero.charter.veils.placeholder')}
        items={draft.veils}
        onChange={(veils) => setDraft({ ...draft, veils })}
      />
      <ListEditor
        name={SESSION_ZERO_FIELD.safetyTools}
        label={t('sessionZero.charter.safetyTools.formLabel')}
        help={t('sessionZero.charter.safetyTools.formHelp')}
        placeholder={t('sessionZero.charter.safetyTools.placeholder')}
        items={draft.safetyTools}
        onChange={(safetyTools) => setDraft({ ...draft, safetyTools })}
      />
      <Field
        idPrefix={SESSION_ZERO_PREFIX}
        name={SESSION_ZERO_FIELD.houseRules}
        as="textarea"
        label={t('sessionZero.charter.houseRules.formLabel')}
        help={t('sessionZero.charter.houseRules.formHelp')}
        value={draft.houseRules}
        placeholder={t('sessionZero.charter.houseRules.placeholder')}
        onChange={(e) => setDraft({ ...draft, houseRules: e.target.value })}
        rows={4}
        minHeight={96}
        optional
      />
      <Field
        idPrefix={SESSION_ZERO_PREFIX}
        name={SESSION_ZERO_FIELD.tone}
        as="textarea"
        label={t('sessionZero.charter.tone.formLabel')}
        help={t('sessionZero.charter.tone.formHelp')}
        value={draft.toneAndExpectations}
        placeholder={t('sessionZero.charter.tone.placeholder')}
        onChange={(e) => setDraft({ ...draft, toneAndExpectations: e.target.value })}
        rows={4}
        minHeight={96}
        optional
      />
    </Card>
  );
}
