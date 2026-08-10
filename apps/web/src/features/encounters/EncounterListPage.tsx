/**
 * Encounter list — /c/:campaignId/encounters.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ListDetailLink } from '../../components/ListDetailLink';
import { useRestoreListOriginScroll } from '../../hooks/useRestoreListOriginScroll';
import type { Encounter, EncounterStatus } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Card, Btn, Skeleton, ErrorNote, EmptyState, Chip, TextInput } from '../../components/ui';
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
import { AudienceField, audienceToHidden, type AudienceValue } from '../../components/AudienceField';
import { PageHeader, type PageHeaderSecondaryAction } from '../../components/PageHeader';
import { usePageHeaderDraftWithAi } from '../ai-dm/usePageHeaderDraftWithAi';
import { useAiDmLiveActivity } from '../ai-dm/useAiDmLiveActivity';
import { GameIcon } from '../../components/GameIcon';
import {
  ENCOUNTER_NAME_HELP,
  ENCOUNTER_NAME_LABEL,
  ENCOUNTER_NAME_PLACEHOLDER,
} from './postCreateGuidance';
import { GenerateEncounterWizard } from './GenerateEncounterWizard';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

function encounterStatusLabel(status: EncounterStatus, t: ReturnType<typeof useTranslation>['t']): string {
  return t(`encounters.status.${status}`);
}

const STATUS_TAG_CLASS: Record<EncounterStatus, string> = {
  preparing: 'tag tag-neutral',
  running: 'tag tag-accent',
  ended: 'tag tag-outline',
};

type StatusFilter = 'all' | EncounterStatus;

const STATUS_FILTERS: StatusFilter[] = ['all', 'preparing', 'running', 'ended'];

function encounterListUrl(campaignId: number, status: StatusFilter, query: string): string {
  const params = new URLSearchParams();
  if (status !== 'all') params.set('status', status);
  const trimmed = query.trim();
  if (trimmed) params.set('q', trimmed);
  const qs = params.toString();
  return `${API}/campaigns/${campaignId}/encounters${qs ? `?${qs}` : ''}`;
}

export default function EncounterListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { isDm, canDmWrite } = useCampaignAccess();
  const liveActivity = useAiDmLiveActivity();
  useRestoreListOriginScroll();

  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const fetchGeneration = useRef(0);
  const [creating, setCreating] = useState(() => searchParams.get('action') === 'new');
  const [quickFightLoading, setQuickFightLoading] = useState(false);
  const [sampleFightLoading, setSampleFightLoading] = useState(false);

  // Issue #1932: one-click seeded demo — 4 pregens, 4 monsters, and a generated map,
  // composed server-side from the same write paths a DM would use manually.
  const handleSampleFight = useCallback(async () => {
    setSampleFightLoading(true);
    setError(null);
    try {
      const result = await api.post<{ encounterId: number }>(`${API}/campaigns/${id}/sample-encounter`);
      navigate(`/c/${id}/encounters/${result.encounterId}`);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.sampleFight' }));
      setSampleFightLoading(false);
    }
  }, [id, navigate, t]);

  const handleQuickFight = useCallback(async () => {
    setQuickFightLoading(true);
    setError(null);
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const defaultName = `Quick fight - ${dateStr}`;
      const created = await api.post<Encounter>(`${API}/campaigns/${id}/encounters`, {
        name: defaultName,
        hidden: true,
      });
      const characters = await api
        .get<Array<{ id: number; name: string; hpMax: number }>>(`${API}/campaigns/${id}/characters`)
        .catch(() => []);
      if (characters.length > 0) {
        await Promise.all(
          characters.map((c) =>
            api
              .post(`${API}/encounters/${created.id}/combatants`, {
                kind: 'character',
                characterId: c.id,
                name: c.name,
                hpMax: c.hpMax,
              })
              .catch(() => null),
          ),
        );
      }
      navigate(`/c/${id}/encounters/${created.id}`);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.create' }));
      setQuickFightLoading(false);
    }
  }, [id, navigate, t]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filtersActive = statusFilter !== 'all' || debouncedSearch.trim() !== '';

  const closeCreating = useCallback(() => {
    setCreating(false);
    if (searchParams.get('action') === 'new') {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('action');
          return next;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setCreating(true);
    }
  }, [searchParams]);
  const [generating, setGenerating] = useState(false);
  const { secondaryAction: draftAction, draftDialog } = usePageHeaderDraftWithAi({
    campaignId: id,
    target: 'encounter',
  });

  /**
   * Encounter ids the reader has already been shown. `null` until the first load completes, so
   * the initial page render is not announced as a pile of arrivals.
   */
  const seenEncounterIds = useRef<Set<number> | null>(null);
  const [arrivalMessage, setArrivalMessage] = useState('');

  // Changing the status filter or the search term changes WHICH encounters are listed, not
  // which ones exist. Re-baseline silently so a row coming back into a filter is not announced
  // as a new arrival — an announcement that cries wolf is worse than none.
  useEffect(() => {
    seenEncounterIds.current = null;
    setArrivalMessage('');
  }, [id, statusFilter, debouncedSearch]);

  const load = useCallback(async () => {
    const gen = ++fetchGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Encounter[]>(encounterListUrl(id, statusFilter, debouncedSearch));
      if (gen !== fetchGeneration.current) return;
      // Issue #1022: an encounter can now appear here without the DM having done anything —
      // the AI Driver creates one mid-scene. A sighted DM sees a new card slide in; a screen
      // reader user previously got only the unchanged "N encounters" count, so the arrival was
      // silent. Name what actually appeared, into the SAME live region the page already owns
      // (never a second aria-live region — see CheckRequests.tsx).
      const previous = seenEncounterIds.current;
      const arrived = previous === null ? [] : data.filter((e) => !previous.has(e.id));
      seenEncounterIds.current = new Set(data.map((e) => e.id));
      setArrivalMessage(
        arrived.length > 0 ? t('encounters.list.arrived', { count: arrived.length, names: arrived.map((e) => e.name).join(', ') }) : '',
      );
      setEncounters(data);
    } catch (err) {
      if (gen !== fetchGeneration.current) return;
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.load' }));
    } finally {
      if (gen === fetchGeneration.current) setLoading(false);
    }
  }, [id, statusFilter, debouncedSearch, t]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  const statusMessage = useMemo(() => {
    if (loading) return '';
    // An arrival takes precedence over the bare count: "2 encounters" is what the reader
    // already believed, while "Ambush in the Reeds was added" is the thing that changed.
    if (arrivalMessage) return arrivalMessage;
    if (encounters.length === 0) {
      return filtersActive ? t('encounters.list.noResults') : t('encounters.empty.title');
    }
    return t('encounters.list.resultCount', { count: encounters.length });
  }, [arrivalMessage, encounters.length, filtersActive, loading, t]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={t('common.noCampaign')} />
      </div>
    );
  }

  const secondaryActions: PageHeaderSecondaryAction[] = draftAction ? [draftAction] : [];

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <PageHeader
        title={t('encounters.title')}
        secondaryActions={secondaryActions}
        primaryAction={
          canDmWrite && !creating && !generating ? (
            <div className="flex gap-2 flex-wrap">
              <Btn type="button" className="cf-page-header__action" ghost onClick={() => setGenerating(true)} disabled={quickFightLoading}>
                {t('encounters.generate')}
              </Btn>
              <Btn type="button" className="cf-page-header__action" ghost onClick={handleQuickFight} disabled={quickFightLoading} data-testid="quick-fight-button">
                {quickFightLoading ? 'Creating…' : t('encounters.quickFight', 'Quick fight')}
              </Btn>
              <Btn type="button" className="cf-page-header__action" onClick={() => setCreating(true)} disabled={quickFightLoading} data-testid="new-encounter-button">
                {t('encounters.newEncounter')}
              </Btn>
            </div>
          ) : undefined
        }
      />
      {draftDialog}

      {error && <ErrorNote message={error} onRetry={load} />}

      {canDmWrite && generating && (
        <GenerateEncounterWizard campaignId={id} onCancel={() => setGenerating(false)} />
      )}

      {canDmWrite && creating && (
        <NewEncounterForm campaignId={id} onCancel={closeCreating} />
      )}

      <div className="space-y-3" data-testid="encounter-list-filters">
        <TextInput
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('encounters.list.searchPlaceholder')}
          aria-label={t('encounters.list.searchPlaceholder')}
          className="w-full"
        />
        <div className="flex gap-1.5 flex-wrap" role="radiogroup" aria-label={t('encounters.list.filterStatus')}>
          {STATUS_FILTERS.map((filter) => {
            const checked = statusFilter === filter;
            const label = filter === 'all' ? t('encounters.list.filterAll') : encounterStatusLabel(filter, t);
            return (
              <button
                key={filter}
                type="button"
                role="radio"
                aria-checked={checked}
                data-testid={`encounter-status-filter-${filter}`}
                onClick={() => setStatusFilter(filter)}
                className={checked ? 'tag tag-accent' : 'tag tag-neutral'}
                style={{ cursor: 'pointer', border: 0, font: 'inherit', fontSize: 11, minHeight: 30 }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {statusMessage}
        </div>
      </div>

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : encounters.length === 0 ? (
        <EmptyState
          icon="crossed-swords"
          title={filtersActive ? t('encounters.list.noResults') : t('encounters.empty.title')}
          hint={
            filtersActive
              ? undefined
              : isDm
                ? t('encounters.empty.hintDm')
                : t('encounters.empty.hintPlayer')
          }
          action={
            !filtersActive && (canDmWrite || liveActivity.mode === 'driver') ? (
              <div className="flex gap-2 flex-wrap justify-center">
                {liveActivity.mode === 'driver' && (
                  <Btn
                    type="button"
                    ghost
                    onClick={() => navigate(`/c/${id}/table`)}
                    data-testid="encounter-list-live-session"
                  >
                    {t('encounters.driver.toggle')}
                  </Btn>
                )}
                {canDmWrite && (
                  <Btn
                    type="button"
                    onClick={handleSampleFight}
                    disabled={sampleFightLoading}
                    data-testid="sample-fight-button"
                  >
                    {sampleFightLoading ? t('encounters.empty.sampleFightLoading') : t('encounters.empty.sampleFight')}
                  </Btn>
                )}
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {encounters.map((enc) => (
            <EncounterCard key={enc.id} campaignId={id} encounter={enc} showHidden={isDm} />
          ))}
        </div>
      )}
    </div>
  );
}

function EncounterCard({
  campaignId,
  encounter,
  showHidden,
}: {
  campaignId: number;
  encounter: Encounter;
  showHidden?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card
      to={`/c/${campaignId}/encounters/${encounter.id}`}
      density="compact" elev="sm" as={ListDetailLink}
      style={{ color: 'var(--color-text)', textDecoration: 'none', gap: 10 }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="card-title" style={{ fontSize: 15 }}>
          {encounter.name}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={STATUS_TAG_CLASS[encounter.status]} style={{ fontSize: 10 }}>
          {encounterStatusLabel(encounter.status, t)}
        </span>
        {encounter.status === 'running' && (
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>
            Round {encounter.round}
          </span>
        )}
        {showHidden && encounter.hidden && (
          <Chip variant="failed">
            <span className="inline-flex items-center gap-1">
              <GameIcon slug="sight-disabled" size={UI_ICON_SIZE.xs} /> Hidden
            </span>
          </Chip>
        )}
      </div>
    </Card>
  );
}

/** Minimal shapes for the link-picker option lists. */
type NamedRow = { id: number; name?: string; title?: string; number?: number };

const defaultEncounterName = () => `Untitled encounter - ${new Date().toISOString().slice(0, 10)}`;

function NewEncounterForm({ campaignId, onCancel }: { campaignId: number; onCancel: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState(defaultEncounterName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #754: Preparing encounters default to DM-only.
  const [audience, setAudience] = useState<AudienceValue>('dm');

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
    const trimmed = name.trim() || defaultEncounterName();
    setSaving(true);
    setError(null);
    try {
      const hidden = audienceToHidden(audience);
      const created = await api.post<Encounter>(`${API}/campaigns/${campaignId}/encounters`, {
        name: trimmed,
        locationId: locationId ? Number(locationId) : undefined,
        questId: questId ? Number(questId) : undefined,
        sessionId: sessionId ? Number(sessionId) : undefined,
        hidden,
      });
      navigate(`/c/${campaignId}/encounters/${created.id}`);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.create' }));
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3" data-testid="encounter-create-form">
      <h2 className="font-bold text-white text-sm">New encounter</h2>
      {error && (
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
        />
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <Field
            idPrefix={ENCOUNTER_CREATE_PREFIX}
            name={ENCOUNTER_FIELD.locationId}
            as="select"
            label={
              <span className="inline-flex items-center gap-1">
                <GameIcon slug="treasure-map" size={UI_ICON_SIZE.xs} /> {ENCOUNTER_LOCATION_LABEL}
              </span>
            }
            labelClassName="text-xs text-slate-400"
            selectClassName="cf-select text-xs w-full cf-density-xs"
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
                <GameIcon slug="scroll-unfurled" size={UI_ICON_SIZE.xs} /> {ENCOUNTER_QUEST_LABEL}
              </span>
            }
            labelClassName="text-xs text-slate-400"
            selectClassName="cf-select text-xs w-full cf-density-xs"
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
                <GameIcon slug="book-cover" size={UI_ICON_SIZE.xs} /> {ENCOUNTER_SESSION_LABEL}
              </span>
            }
            labelClassName="text-xs text-slate-400"
            selectClassName="cf-select text-xs w-full cf-density-xs"
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
        <AudienceField value={audience} onChange={setAudience} entityLabel="encounter" name="encounter-audience" />
        <div className="flex gap-2 justify-end">
          <Btn ghost type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </Btn>
          <Btn type="submit" disabled={saving}>
            {saving ? 'Creating…' : 'Create'}
          </Btn>
        </div>
      </form>
    </Card>
  );
}
