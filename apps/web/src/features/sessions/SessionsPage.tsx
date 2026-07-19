/**
 * Session log — mirrors design/07-sessions.html.
 * Route: /c/:campaignId/sessions ; optional ?session=:id selects the detail pane.
 * Two-pane desktop layout; mobile shows list OR detail (tap in, back out).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Session } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';

export default function SessionsPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const selectedId = searchParams.get('session');

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [showAddForm, setShowAddForm] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      const list = await api.get<Session[]>(`${API}/campaigns/${cid}/sessions`);
      setSessions(list);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError("Couldn't load sessions.");
      }
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  const selected = useMemo(
    () => (selectedId ? sessions.find((s) => String(s.id) === selectedId) : sessions[0]),
    [sessions, selectedId],
  );

  function selectSession(id: number) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('session', String(id));
      return next;
    });
  }

  function backToList() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('session');
      return next;
    });
  }

  function nextNumber() {
    return sessions.reduce((max, s) => Math.max(max, s.number), 0) + 1;
  }

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="🔒" title="You don't have access to this campaign" />
        </Card>
      </div>
    );
  }

  if (loading && sessions.length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5 grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card>
          <Skeleton lines={4} />
        </Card>
        <Card className="lg:col-span-2">
          <Skeleton lines={6} />
        </Card>
      </div>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  const showDetailOnMobile = Boolean(selected);

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 grid grid-cols-1 lg:grid-cols-3 gap-5 pb-20 lg:pb-10">
      {error && (
        <div className="lg:col-span-3">
          <ErrorNote message={error} onRetry={load} />
        </div>
      )}

      {/* Timeline list */}
      <aside className={`space-y-3 ${showDetailOnMobile ? 'hidden lg:block' : ''}`}>
        <div className="flex items-center justify-between">
          <h1 className="font-bold text-white">Session log</h1>
          {isDm && (
            <Btn
              className="!min-h-0 !py-1.5 text-xs"
              onClick={() => {
                setShowAddForm(true);
                if (selected) selectSession(selected.id);
              }}
            >
              + Add recap
            </Btn>
          )}
        </div>

        {sessions.length === 0 && (
          <EmptyState title="No sessions yet — add your first recap" />
        )}

        {sessions.map((s) => {
          const isActive = selected?.id === s.id;
          return (
            <button
              key={s.id}
              onClick={() => selectSession(s.id)}
              className={`cf-card block w-full text-left p-4 space-y-1 ${
                isActive ? 'border-amber-500/50' : 'hover:border-slate-500'
              }`}
            >
              <div className="flex items-center justify-between">
                <p className={`font-bold text-sm ${isActive ? 'text-white' : 'text-slate-300'}`}>
                  Session {s.number}
                </p>
                <span className="text-[10px] text-slate-500">{formatDate(s.playedAt)}</span>
              </div>
              <p className={`text-xs font-semibold ${isActive ? 'text-amber-400' : 'text-slate-400'}`}>
                {s.title || 'Untitled session'}
              </p>
            </button>
          );
        })}
      </aside>

      {/* Recap detail */}
      <main className={`lg:col-span-2 space-y-5 ${showDetailOnMobile ? '' : 'hidden lg:block'}`}>
        {selected ? (
          <SessionDetail
            campaignId={cid}
            session={selected}
            isDm={isDm}
            onBack={backToList}
            onChange={load}
          />
        ) : (
          <Card>
            <EmptyState title="No sessions yet — add your first recap" hint="Pick a session on the left, or add one below." />
          </Card>
        )}

        {isDm && (showAddForm || sessions.length === 0) && (
          <AddRecapForm
            campaignId={cid}
            nextNumber={nextNumber()}
            onCreated={(created) => {
              setShowAddForm(false);
              selectSession(created.id);
              void load();
            }}
            onCancel={sessions.length > 0 ? () => setShowAddForm(false) : undefined}
          />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SessionDetail({
  campaignId,
  session,
  isDm,
  onBack,
  onChange,
}: {
  campaignId: number;
  session: Session;
  isDm: boolean;
  onBack: () => void;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session.title);
  const [dateDraft, setDateDraft] = useState(toDateInputValue(session.playedAt));
  const [recapDraft, setRecapDraft] = useState(session.recap);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setTitleDraft(session.title);
    setDateDraft(toDateInputValue(session.playedAt));
    setRecapDraft(session.recap);
  }, [session]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch<Session>(`${API}/sessions/${session.id}`, {
        title: titleDraft,
        playedAt: dateDraft ? dateDraft : null,
        recap: recapDraft,
      });
      setEditing(false);
      onChange();
    } catch {
      setError("Couldn't save the recap.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete Session ${session.number}? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api.delete(`${API}/sessions/${session.id}`);
      onChange();
      onBack();
    } catch {
      setError("Couldn't delete the session.");
      setDeleting(false);
    }
  }

  return (
    <Card className="space-y-5">
      {error && <ErrorNote message={error} />}
      <div className="flex items-start justify-between gap-3 border-b border-slate-700 pb-4">
        <div className="space-y-1">
          <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-300 lg:hidden mb-1 block">
            ← Back to sessions
          </button>
          <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
            Session {session.number} · {formatDate(session.playedAt)}
          </p>
          <h2 className="text-2xl font-extrabold text-white">{session.title || 'Untitled session'}</h2>
        </div>
        {isDm && (
          <div className="flex gap-2 shrink-0">
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditing((v) => !v)}>
              ✎ Edit
            </Btn>
            <Btn danger ghost className="!min-h-0 !py-1.5 text-xs" onClick={remove} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Btn>
          </div>
        )}
      </div>

      {editing ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Title</label>
            <TextInput value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} placeholder="Session title…" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Played on</label>
            <TextInput type="date" value={dateDraft} onChange={(e) => setDateDraft(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Recap</label>
            <TextArea
              style={{ minHeight: 200 }}
              value={recapDraft}
              onChange={(e) => setRecapDraft(e.target.value)}
              placeholder="What happened? Plain text is fine — # headings and - bullets render nicely."
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Btn>
            <Btn className="!min-h-0 !py-1.5 text-xs" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {session.recap ? (
            <Markdown>{session.recap}</Markdown>
          ) : (
            <p className="text-sm text-slate-600">No recap written yet.</p>
          )}
        </div>
      )}
    </Card>
  );
}

function AddRecapForm({
  campaignId,
  nextNumber,
  onCreated,
  onCancel,
}: {
  campaignId: number;
  nextNumber: number;
  onCreated: (session: Session) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState('');
  const [playedAt, setPlayedAt] = useState(new Date().toISOString().slice(0, 10));
  const [recap, setRecap] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function publish() {
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<Session>(`${API}/campaigns/${campaignId}/sessions`, {
        number: nextNumber,
        title: title.trim(),
        playedAt: playedAt || null,
        recap,
      });
      setTitle('');
      setRecap('');
      onCreated(created);
    } catch {
      setError("Couldn't publish the recap.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm">+ Add recap (Session {nextNumber})</h2>
      {error && <ErrorNote message={error} onRetry={publish} />}
      <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder={'Title, e.g. "The Dragon’s Shadow"'} />
      <TextInput type="date" value={playedAt} onChange={(e) => setPlayedAt(e.target.value)} />
      <TextArea
        className="!min-h-[100px]"
        value={recap}
        onChange={(e) => setRecap(e.target.value)}
        placeholder="What happened? Plain text is fine — # headings and - bullets render nicely."
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-slate-500">
          Tip: or just say <em>"sweep the inbox"</em> to your AI scribe.
        </p>
        <div className="flex gap-2 shrink-0">
          {onCancel && (
            <Btn ghost className="!min-h-0 !py-2 text-sm" onClick={onCancel}>
              Cancel
            </Btn>
          )}
          <Btn className="!min-h-0 !py-2 text-sm" onClick={publish} disabled={saving}>
            {saving ? 'Publishing…' : 'Publish recap'}
          </Btn>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return 'Undated';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Undated';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
