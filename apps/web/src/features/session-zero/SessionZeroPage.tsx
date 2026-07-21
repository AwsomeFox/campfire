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
import type { SessionZero } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Markdown } from '../../components/Markdown';
import { Skeleton, ErrorNote, EmptyState, Btn, TextInput, TextArea } from '../../components/ui';

interface Draft {
  lines: string[];
  veils: string[];
  safetyTools: string[];
  houseRules: string;
  toneAndExpectations: string;
}

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

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const c = await api.get<SessionZero>(`${API}/campaigns/${cid}/session-zero`);
      setCharter(c);
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
    </div>
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
  label,
  hint,
  placeholder,
  items,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <div>
      <label className="text-muted" style={{ fontSize: 11 }}>{label}</label>
      <div className="text-muted" style={{ fontSize: 11, marginBottom: 4 }}>{hint} One per line.</div>
      <TextArea
        rows={4}
        value={items.join('\n')}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.split('\n'))}
      />
    </div>
  );
}

function CharterForm({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft | null) => void }) {
  return (
    <div className="card elev-sm" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ListEditor
        label="Lines (hard limits)"
        hint="Content that never appears at the table."
        placeholder={'Harm to children\nSexual violence\nSpiders'}
        items={draft.lines}
        onChange={(lines) => setDraft({ ...draft, lines })}
      />
      <ListEditor
        label="Veils (soft limits)"
        hint="Content that may exist but stays off-screen."
        placeholder={'On-screen torture\nGraphic gore'}
        items={draft.veils}
        onChange={(veils) => setDraft({ ...draft, veils })}
      />
      <ListEditor
        label="Safety tools"
        hint="Tools the table agreed to use."
        placeholder={'X-Card\nOpen Door\nScript Change'}
        items={draft.safetyTools}
        onChange={(safetyTools) => setDraft({ ...draft, safetyTools })}
      />
      <div>
        <label className="text-muted" style={{ fontSize: 11 }}>House rules (markdown, optional)</label>
        <TextArea
          rows={4}
          value={draft.houseRules}
          placeholder="Table conventions, rules-as-written deviations…"
          onChange={(e) => setDraft({ ...draft, houseRules: e.target.value })}
        />
      </div>
      <div>
        <label className="text-muted" style={{ fontSize: 11 }}>Tone & content expectations (markdown, optional)</label>
        <TextArea
          rows={4}
          value={draft.toneAndExpectations}
          placeholder="Gritty vs. heroic, comedic vs. serious, spotlight & PvP norms…"
          onChange={(e) => setDraft({ ...draft, toneAndExpectations: e.target.value })}
        />
      </div>
    </div>
  );
}
