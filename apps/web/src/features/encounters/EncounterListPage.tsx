/**
 * Encounter list — /c/:campaignId/encounters.
 * Mirrors design/claude-design/Campfire.dc.html "Encounter" header conventions
 * (status chip + round tag, ~L949-951) applied to a card grid, same shape as
 * other list pages (PartyPage/SessionsPage): a "+ New encounter" inline form
 * for the DM, cards linking to the live tracker.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Encounter, EncounterStatus } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Btn, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { Field } from '../../components/Field';
import {
  ENCOUNTER_CREATE_PREFIX,
  ENCOUNTER_FIELD,
  ENCOUNTER_LOCATION_HELP,
  ENCOUNTER_LOCATION_LABEL,
  ENCOUNTER_QUEST_HELP,
  ENCOUNTER_QUEST_LABEL,
  ENCOUNTER_SESSION_HELP,
  ENCOUNTER_SESSION_LABEL,
} from '../../components/formFieldLabels';
import { DraftWithAiButton } from '../ai-dm/DraftWithAiButton';
import { GameIcon } from '../../components/GameIcon';
import {
  ENCOUNTER_NAME_HELP,
  ENCOUNTER_NAME_LABEL,
  ENCOUNTER_NAME_PLACEHOLDER,
} from './postCreateGuidance';

const STATUS_LABEL: Record<EncounterStatus, string> = {
  preparing: 'Preparing',
  running: 'Running',
  ended: 'Ended',
};

const STATUS_TAG_CLASS: Record<EncounterStatus, string> = {
  preparing: 'tag tag-neutral',
  running: 'tag tag-accent',
  ended: 'tag tag-outline',
};

export default function EncounterListPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn } = useAuth();
  const role = roleIn(id);
  const isDm = role === 'dm';

  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<Encounter[]>(`${API}/campaigns/${id}/encounters`);
      setEncounters(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load encounters.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-extrabold text-white">Encounters</h1>
        <div className="flex-1" />
        <DraftWithAiButton campaignId={id} target="encounter" />
        {isDm && !creating && (
          <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => setCreating(true)}>
            + New encounter
          </Btn>
        )}
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {isDm && creating && (
        <NewEncounterForm campaignId={id} onCancel={() => setCreating(false)} />
      )}

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : encounters.length === 0 ? (
        <EmptyState
          icon="crossed-swords"
          title="No encounters yet"
          hint={isDm ? 'Start one when combat kicks off.' : 'The DM hasn’t started one yet.'}
        />
      ) : (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {encounters.map((enc) => (
            <EncounterCard key={enc.id} campaignId={id} encounter={enc} />
          ))}
        </div>
      )}
    </div>
  );
}

function EncounterCard({ campaignId, encounter }: { campaignId: number; encounter: Encounter }) {
  return (
    <Link
      to={`/c/${campaignId}/encounters/${encounter.id}`}
      className="card elev-sm"
      style={{ color: 'var(--color-text)', textDecoration: 'none', gap: 10 }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="card-title" style={{ fontSize: 15 }}>
          {encounter.name}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={STATUS_TAG_CLASS[encounter.status]} style={{ fontSize: 10 }}>
          {STATUS_LABEL[encounter.status]}
        </span>
        {encounter.status === 'running' && (
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>
            Round {encounter.round}
          </span>
        )}
      </div>
    </Link>
  );
}

/** Minimal shapes for the link-picker option lists. */
type NamedRow = { id: number; name?: string; title?: string; number?: number };

function NewEncounterForm({ campaignId, onCancel }: { campaignId: number; onCancel: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Optional where/why/when links (issue #126). Loaded lazily so opening the form
  // doesn't block on three list fetches — empty selects just show "— none —".
  const [locations, setLocations] = useState<NamedRow[]>([]);
  const [quests, setQuests] = useState<NamedRow[]>([]);
  const [sessions, setSessions] = useState<NamedRow[]>([]);
  const [locationId, setLocationId] = useState('');
  const [questId, setQuestId] = useState('');
  const [sessionId, setSessionId] = useState('');

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.get<NamedRow[]>(`${API}/campaigns/${campaignId}/locations`).catch(() => []),
      api.get<NamedRow[]>(`${API}/campaigns/${campaignId}/quests`).catch(() => []),
      api.get<NamedRow[]>(`${API}/campaigns/${campaignId}/sessions`).catch(() => []),
    ]).then(([locs, qs, sess]) => {
      if (cancelled) return;
      setLocations(locs);
      setQuests(qs);
      setSessions(sess);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter an encounter name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<Encounter>(`${API}/campaigns/${campaignId}/encounters`, {
        name: trimmed,
        locationId: locationId ? Number(locationId) : undefined,
        questId: questId ? Number(questId) : undefined,
        sessionId: sessionId ? Number(sessionId) : undefined,
      });
      navigate(`/c/${campaignId}/encounters/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the encounter.");
      setSaving(false);
    }
  }

  const nameInvalid = !!error && !name.trim();
  const formError = nameInvalid ? error : null;

  return (
    <Card className="space-y-3" data-testid="encounter-create-form">
      <h2 className="font-bold text-white text-sm">New encounter</h2>
      {error && !nameInvalid && (
        <p className="text-sm text-rose-400" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="space-y-3">
        <Field
          idPrefix={ENCOUNTER_CREATE_PREFIX}
          name={ENCOUNTER_FIELD.name}
          label={ENCOUNTER_NAME_LABEL}
          labelClassName="text-xs text-slate-400"
          placeholder={ENCOUNTER_NAME_PLACEHOLDER}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          maxLength={120}
          autoFocus
          required
          help={ENCOUNTER_NAME_HELP}
          error={formError}
        />
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <Field
            idPrefix={ENCOUNTER_CREATE_PREFIX}
            name={ENCOUNTER_FIELD.locationId}
            as="select"
            label={
              <span className="inline-flex items-center gap-1">
                <GameIcon slug="treasure-map" size={12} /> {ENCOUNTER_LOCATION_LABEL}
              </span>
            }
            labelClassName="text-xs text-slate-400"
            selectClassName="cf-select !min-h-0 !py-2 text-xs w-full"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            help={ENCOUNTER_LOCATION_HELP}
            optional
          >
            <option value="">— none —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name ?? `#${l.id}`}
              </option>
            ))}
          </Field>
          <Field
            idPrefix={ENCOUNTER_CREATE_PREFIX}
            name={ENCOUNTER_FIELD.questId}
            as="select"
            label={
              <span className="inline-flex items-center gap-1">
                <GameIcon slug="scroll-unfurled" size={12} /> {ENCOUNTER_QUEST_LABEL}
              </span>
            }
            labelClassName="text-xs text-slate-400"
            selectClassName="cf-select !min-h-0 !py-2 text-xs w-full"
            value={questId}
            onChange={(e) => setQuestId(e.target.value)}
            help={ENCOUNTER_QUEST_HELP}
            optional
          >
            <option value="">— none —</option>
            {quests.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title ?? `#${q.id}`}
              </option>
            ))}
          </Field>
          <Field
            idPrefix={ENCOUNTER_CREATE_PREFIX}
            name={ENCOUNTER_FIELD.sessionId}
            as="select"
            label={
              <span className="inline-flex items-center gap-1">
                <GameIcon slug="book-cover" size={12} /> {ENCOUNTER_SESSION_LABEL}
              </span>
            }
            labelClassName="text-xs text-slate-400"
            selectClassName="cf-select !min-h-0 !py-2 text-xs w-full"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            help={ENCOUNTER_SESSION_HELP}
            optional
          >
            <option value="">— none —</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title || `Session ${s.number ?? s.id}`}
              </option>
            ))}
          </Field>
        </div>
        <div className="flex gap-2 justify-end">
          <Btn ghost type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </Btn>
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create'}
          </Btn>
        </div>
      </form>
    </Card>
  );
}
