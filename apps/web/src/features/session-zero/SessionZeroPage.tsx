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
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { ParticipantSupportPreference, SessionZero, SupportPreferenceVisibility } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Markdown } from '../../components/Markdown';
import { Field } from '../../components/Field';
import {
  SESSION_ZERO_FIELD,
  SESSION_ZERO_HOUSE_RULES_HELP,
  SESSION_ZERO_HOUSE_RULES_LABEL,
  SESSION_ZERO_LINES_HELP,
  SESSION_ZERO_LINES_LABEL,
  SESSION_ZERO_PREFIX,
  SESSION_ZERO_SUPPORT_HELP,
  SESSION_ZERO_SUPPORT_LABEL,
  SESSION_ZERO_TONE_HELP,
  SESSION_ZERO_TONE_LABEL,
  SESSION_ZERO_TOOLS_HELP,
  SESSION_ZERO_TOOLS_LABEL,
  SESSION_ZERO_VEILS_HELP,
  SESSION_ZERO_VEILS_LABEL,
} from '../../components/formFieldLabels';
import { Skeleton, ErrorNote, EmptyState, Btn } from '../../components/ui';

interface Draft {
  lines: string[];
  veils: string[];
  safetyTools: string[];
  houseRules: string;
  toneAndExpectations: string;
}

interface SupportDraft {
  supportText: string;
  visibility: SupportPreferenceVisibility;
  aiUseConsent: boolean;
}

const EMPTY_SUPPORT_DRAFT: SupportDraft = {
  supportText: '',
  visibility: 'facilitator',
  aiUseConsent: false,
};

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
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const isDm = roleIn(cid) === 'dm';

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
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const [c, own, visible] = await Promise.all([
        api.get<SessionZero>(`${API}/campaigns/${cid}/session-zero`),
        api.get<ParticipantSupportPreference | null>(`${API}/campaigns/${cid}/session-zero/support-preferences/me`),
        api.get<ParticipantSupportPreference[]>(`${API}/campaigns/${cid}/session-zero/support-preferences`),
      ]);
      setCharter(c);
      setOwnSupport(own ?? null);
      setVisibleSupports(visible);
      setSupportDraft(
        own
          ? { supportText: own.supportText, visibility: own.visibility, aiUseConsent: own.aiUseConsent }
          : EMPTY_SUPPORT_DRAFT,
      );
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setForbidden(true);
      else setError("Couldn't load the session-zero charter.");
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  const startEdit = () => {
    if (!charter) return;
    setDraft(draftFrom(charter));
    setEditing(true);
    setActionError(null);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.put<SessionZero>(`${API}/campaigns/${cid}/session-zero`, {
        lines: cleanList(draft.lines),
        veils: cleanList(draft.veils),
        safetyTools: cleanList(draft.safetyTools),
        houseRules: draft.houseRules,
        toneAndExpectations: draft.toneAndExpectations,
      });
      setCharter(updated);
      setEditing(false);
      setDraft(null);
    } catch {
      setActionError("Couldn't save the charter.");
    } finally {
      setBusy(false);
    }
  };

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
      setSupportMessage(e instanceof ApiError ? e.message : "Couldn't save your support preference.");
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
      setSupportMessage(e instanceof ApiError ? e.message : "Couldn't delete your support preference.");
    } finally {
      setSupportBusy(false);
    }
  };

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <EmptyState icon="padlock" title="You don't have access to this campaign" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 pb-20 md:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: '4px 0 0' }}>Session Zero</h3>
        <div style={{ flex: 1 }} />
        {isDm && !editing && !loading && (
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

      {loading && !charter ? (
        <div className="card elev-sm">
          <Skeleton lines={6} />
        </div>
      ) : editing && draft ? (
        <CharterForm draft={draft} setDraft={setDraft} />
      ) : charter && isEmptyCharter(charter) ? (
        <EmptyState
          icon="life-buoy"
          title="No session-zero charter yet"
          hint={isDm ? 'Record your table’s lines & veils, safety tools, and house rules with "Edit charter".' : "The DM hasn’t recorded the table's charter yet."}
        />
      ) : charter ? (
        <CharterView charter={charter} />
      ) : null}

      {editing && draft && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={save} disabled={busy}>Save charter</Btn>
          <Btn ghost onClick={() => { setEditing(false); setDraft(null); }} disabled={busy}>Cancel</Btn>
        </div>
      )}

      {!loading && (
        <section
          aria-labelledby="access-support-heading"
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div style={{ marginTop: 10 }}>
            <h3 id="access-support-heading" style={{ margin: 0 }}>Access support</h3>
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
  return (
    <Section
      title={facilitator ? 'Facilitator prep / live summary' : 'Table-shared support'}
      hint={facilitator
        ? 'A concise view of what participants authorized facilitators to read. AI access remains separately consented.'
        : 'Only preferences participants chose to share with the entire table.'}
    >
      {visible.length === 0 ? (
        <span className="text-muted" style={{ fontStyle: 'italic', fontSize: 13 }}>No preferences shared for this view.</span>
      ) : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 10, listStyle: 'none', margin: 0, padding: 0 }}>
          {visible.map((entry) => (
            <li key={entry.id} style={{ fontSize: 13 }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong>{entry.ownerName || 'Participant'}</strong>
                <span className="text-muted">{entry.visibility === 'table' ? 'Entire table' : 'Facilitators only'}</span>
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
    <div className="card elev-sm">
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 500 }}>{title}</div>
      {hint && <div className="text-muted" style={{ fontSize: 11, marginTop: 2 }}>{hint}</div>}
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Section title="Lines" hint="Hard limits — content that never appears at the table.">
        <ChipList items={charter.lines} />
      </Section>
      <Section title="Veils" hint="Soft limits — content that stays off-screen (fade to black).">
        <ChipList items={charter.veils} />
      </Section>
      <Section title="Safety tools" hint="Tools the table has agreed to use (X-Card, Open Door, Script Change…).">
        <ChipList items={charter.safetyTools} />
      </Section>
      {charter.houseRules.trim() !== '' && (
        <Section title="House rules">
          <Markdown>{charter.houseRules}</Markdown>
        </Section>
      )}
      {charter.toneAndExpectations.trim() !== '' && (
        <Section title="Tone & content expectations">
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
  return (
    <div
      className="card elev-sm"
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      data-testid="session-zero-charter-form"
    >
      <ListEditor
        name={SESSION_ZERO_FIELD.lines}
        label={SESSION_ZERO_LINES_LABEL}
        help={SESSION_ZERO_LINES_HELP}
        placeholder={'Harm to children\nSexual violence\nSpiders'}
        items={draft.lines}
        onChange={(lines) => setDraft({ ...draft, lines })}
      />
      <ListEditor
        name={SESSION_ZERO_FIELD.veils}
        label={SESSION_ZERO_VEILS_LABEL}
        help={SESSION_ZERO_VEILS_HELP}
        placeholder={'On-screen torture\nGraphic gore'}
        items={draft.veils}
        onChange={(veils) => setDraft({ ...draft, veils })}
      />
      <ListEditor
        name={SESSION_ZERO_FIELD.safetyTools}
        label={SESSION_ZERO_TOOLS_LABEL}
        help={SESSION_ZERO_TOOLS_HELP}
        placeholder={'X-Card\nOpen Door\nScript Change'}
        items={draft.safetyTools}
        onChange={(safetyTools) => setDraft({ ...draft, safetyTools })}
      />
      <Field
        idPrefix={SESSION_ZERO_PREFIX}
        name={SESSION_ZERO_FIELD.houseRules}
        as="textarea"
        label={SESSION_ZERO_HOUSE_RULES_LABEL}
        help={SESSION_ZERO_HOUSE_RULES_HELP}
        value={draft.houseRules}
        placeholder="Table conventions, rules-as-written deviations…"
        onChange={(e) => setDraft({ ...draft, houseRules: e.target.value })}
        rows={4}
        minHeight={96}
        optional
      />
      <Field
        idPrefix={SESSION_ZERO_PREFIX}
        name={SESSION_ZERO_FIELD.tone}
        as="textarea"
        label={SESSION_ZERO_TONE_LABEL}
        help={SESSION_ZERO_TONE_HELP}
        value={draft.toneAndExpectations}
        placeholder="Gritty vs. heroic, comedic vs. serious, spotlight & PvP norms…"
        onChange={(e) => setDraft({ ...draft, toneAndExpectations: e.target.value })}
        rows={4}
        minHeight={96}
        optional
      />
    </div>
  );
}
