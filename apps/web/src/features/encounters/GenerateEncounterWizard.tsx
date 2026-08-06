import { useTranslation } from 'react-i18next';
/**
 * Generate-encounter wizard (issue #412) — a DM preview-and-tune surface layered over the
 * server generator (#304 / #58). Reachable from the encounter list (and quest/location prep via
 * the same props). Flow: pick target difficulty / theme-environment / roles / duration-shape /
 * constraints → preview a roster with the difficulty EXPLANATION (not just a band) → expand each
 * creature inline (AC/HP/actions/saves/traits) → reroll all / reroll one / adjust count / pin →
 * heed warnings → optionally link quest/session/location → commit ONCE (idempotent) as a hidden,
 * preparing encounter. Keyboard + mobile usable; concise "why this is Moderate/Severe" help.
 *
 * Map generate/select + token placement are supported by the commit endpoint and are performed
 * on the run-session tracker after commit (this wizard links the where/why/when + roster; see the
 * issue notes). Empty compendium / unsupported difficulty math surface actionable `fallbacks`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  DifficultyBand,
  EncounterPreview,
  EncounterRosterSlot,
  EncounterRosterSlotInput,
  EncounterShape,
  EncounterTuneOp,
  EncounterWithCombatants,
} from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Card, Btn, Chip, ErrorNote } from '../../components/ui';
import { UIIcon } from '../../components/UIIcon';
import { Field } from '../../components/Field';
import { AudienceField, audienceToHidden, type AudienceValue } from '../../components/AudienceField';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

type NamedRow = { id: number; name?: string; title?: string; number?: number };

const DIFFICULTY_OPTIONS: { value: DifficultyBand; label: string }[] = [
  { value: 'trivial', label: 'Trivial' },
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
  { value: 'deadly', label: 'Deadly' },
];

const SHAPE_OPTIONS: { value: '' | EncounterShape; label: string }[] = [
  { value: '', label: 'Auto (budget picks)' },
  { value: 'solo', label: 'Solo (1) — boss' },
  { value: 'pair', label: 'Pair (2)' },
  { value: 'group', label: 'Group (3–6) — standard fight' },
  { value: 'horde', label: 'Horde (7+) — swarm' },
];

/** A stable idempotency key per wizard session so a double-click / retry never double-commits. */
function useIdempotencyKey(deps: unknown): string {
  return useMemo(() => {
    const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    return `enc-commit-${rnd}`;
    // Regenerate when the roster identity changes so a fresh commit after editing gets a new key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps]);
}

function planFromPreview(preview: EncounterPreview): EncounterRosterSlotInput[] {
  return preview.plan.map((s) => ({ ...s }));
}

export function GenerateEncounterWizard({
  campaignId,
  onCancel,
  presetLocationId,
  presetQuestId,
}: {
  campaignId: number;
  onCancel: () => void;
  presetLocationId?: number;
  presetQuestId?: number;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // ── generation params ──
  const [difficulty, setDifficulty] = useState<DifficultyBand>('medium');
  const [shape, setShape] = useState<'' | EncounterShape>('');
  const [maxCount, setMaxCount] = useState('12');
  const [creatureType, setCreatureType] = useState('');
  const [environment, setEnvironment] = useState('');
  const [minCr, setMinCr] = useState('');
  const [maxCr, setMaxCr] = useState('');
  const [includeHazards, setIncludeHazards] = useState(false);

  // ── preview / tune state ──
  const [preview, setPreview] = useState<EncounterPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // ── commit params ──
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<AudienceValue>('dm');
  const [locations, setLocations] = useState<NamedRow[]>([]);
  const [quests, setQuests] = useState<NamedRow[]>([]);
  const [sessions, setSessions] = useState<NamedRow[]>([]);
  const [locationId, setLocationId] = useState(presetLocationId ? String(presetLocationId) : '');
  const [questId, setQuestId] = useState(presetQuestId ? String(presetQuestId) : '');
  const [sessionId, setSessionId] = useState('');
  const [committing, setCommitting] = useState(false);

  const rosterFingerprint = preview ? JSON.stringify(preview.plan) : '';
  const idempotencyKey = useIdempotencyKey(rosterFingerprint);
  const liveRegion = useRef<HTMLDivElement>(null);

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

  const buildFilters = useCallback(() => {
    const filters: Record<string, unknown> = {};
    if (creatureType.trim()) filters.creatureType = creatureType.trim();
    if (environment.trim()) filters.environment = environment.trim();
    if (minCr.trim()) {
      const n = Number(minCr);
      if (Number.isFinite(n)) filters.minCr = n;
    }
    if (maxCr.trim()) {
      const n = Number(maxCr);
      if (Number.isFinite(n)) filters.maxCr = n;
    }
    if (includeHazards) filters.includeHazards = true;
    return Object.keys(filters).length > 0 ? filters : undefined;
  }, [creatureType, environment, minCr, maxCr, includeHazards]);

  /** Run a preview: a fresh generate, or a deterministic tune op on the current plan. */
  const runPreview = useCallback(
    async (tune?: EncounterTuneOp) => {
      setLoading(true);
      setError(null);
      try {
        const count = maxCount ? Number(maxCount) : undefined;
        const body: Record<string, unknown> = {
          difficulty,
          shape: shape || undefined,
          count: count !== undefined && Number.isFinite(count) ? count : undefined,
          filters: buildFilters(),
        };
        if (tune && preview) {
          body.roster = preview.plan;
          body.seed = preview.seed;
          body.tune = tune;
        }
        const result = await api.post<EncounterPreview>(`${API}/campaigns/${campaignId}/encounters/preview`, body);
        setPreview(result);
        if (liveRegion.current) liveRegion.current.textContent = `${result.explanation.label}. ${result.roster.length} slot(s).`;
      } catch (err) {
        setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.preview' }));
      } finally {
        setLoading(false);
      }
    },
    [campaignId, difficulty, shape, maxCount, buildFilters, preview],
  );

  const commit = useCallback(async () => {
    if (!preview || preview.roster.length === 0) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await api.post<{ encounter: EncounterWithCombatants; idempotent: boolean }>(
        `${API}/campaigns/${campaignId}/encounters/commit`,
        {
          idempotencyKey,
          name: name.trim() || undefined,
          targetBand: preview.targetBand,
          roster: planFromPreview(preview),
          locationId: locationId ? Number(locationId) : undefined,
          questId: questId ? Number(questId) : undefined,
          sessionId: sessionId ? Number(sessionId) : undefined,
          hidden: audienceToHidden(audience),
          source: 'wizard',
        },
      );
      navigate(`/c/${campaignId}/encounters/${res.encounter.id}`);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.commit' }));
      setCommitting(false);
    }
  }, [preview, campaignId, idempotencyKey, name, locationId, questId, sessionId, audience, navigate]);

  const canCommit = !!preview && preview.roster.length > 0 && !committing;

  return (
    <Card className="space-y-4" data-testid="generate-encounter-wizard">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-bold text-white text-sm inline-flex items-center gap-2">
          <GameIcon slug="dice-twenty-faces-twenty" size={UI_ICON_SIZE.sm} /> Generate encounter
        </h2>
        <Btn ghost type="button" onClick={onCancel}>
          Close
        </Btn>
      </div>

      {error && <ErrorNote message={error} />}
      <div aria-live="polite" className="sr-only" ref={liveRegion} />

      {/* ── Step 1: parameters ── */}
      <fieldset className="space-y-3 border-0 p-0 m-0">
        <legend className="text-xs text-slate-400 font-semibold">{t('encounters.wizard.step1')}</legend>
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <Field
            idPrefix="gen-enc"
            name="difficulty"
            as="select"
            label="Target difficulty"
            labelClassName="text-xs text-slate-400"
            selectClassName="cf-select text-xs w-full cf-density-xs"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as DifficultyBand)}
          >
            {DIFFICULTY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Field>
          <Field
            idPrefix="gen-enc"
            name="shape"
            as="select"
            label="Duration / shape"
            labelClassName="text-xs text-slate-400"
            selectClassName="cf-select text-xs w-full cf-density-xs"
            value={shape}
            onChange={(e) => setShape(e.target.value as '' | EncounterShape)}
          >
            {SHAPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Field>
          <Field
            idPrefix="gen-enc"
            name="creatureType"
            label="Enemy role / type"
            labelClassName="text-xs text-slate-400"
            placeholder="e.g. undead, dragon"
            value={creatureType}
            onChange={(e) => setCreatureType(e.target.value)}
            optional
          />
          <Field
            idPrefix="gen-enc"
            name="environment"
            label="Theme / environment"
            labelClassName="text-xs text-slate-400"
            placeholder="e.g. forest, crypt"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            optional
          />
          <Field
            idPrefix="gen-enc"
            name="minCr"
            type="number"
            label="Min CR"
            labelClassName="text-xs text-slate-400"
            value={minCr}
            onChange={(e) => setMinCr(e.target.value)}
            optional
          />
          <Field
            idPrefix="gen-enc"
            name="maxCr"
            type="number"
            label="Max CR"
            labelClassName="text-xs text-slate-400"
            value={maxCr}
            onChange={(e) => setMaxCr(e.target.value)}
            optional
          />
          <Field
            idPrefix="gen-enc"
            name="maxCount"
            type="number"
            label="Max creatures"
            labelClassName="text-xs text-slate-400"
            value={maxCount}
            onChange={(e) => setMaxCount(e.target.value)}
            optional
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={includeHazards} onChange={(e) => setIncludeHazards(e.target.checked)} />
          Include hazards (traps / environmental dangers)
        </label>
        <div className="flex gap-2">
          <Btn type="button" onClick={() => void runPreview()} disabled={loading}>
            {loading ? 'Generating…' : preview ? 'Regenerate' : 'Preview roster'}
          </Btn>
        </div>
      </fieldset>

      {preview && (
        <>
          <DifficultyExplanationPanel preview={preview} />
          <WarningsPanel preview={preview} />

          {/* ── Step 2: roster + tune ── */}
          <fieldset className="space-y-2 border-0 p-0 m-0">
            <legend className="text-xs text-slate-400 font-semibold flex items-center justify-between w-full">
              <span>{t('encounters.wizard.step2')}</span>
            </legend>
            <div className="flex gap-2 flex-wrap">
              <Btn ghost type="button" onClick={() => void runPreview({ op: 'reroll-all' })} disabled={loading}>
                Reroll all
              </Btn>
              <Btn ghost type="button" onClick={() => void runPreview({ op: 'add-slot' })} disabled={loading}>
                + Add creature
              </Btn>
            </div>
            <div className="space-y-2">
              {preview.roster.map((slot) => (
                <RosterSlotRow
                  key={slot.slotId}
                  slot={slot}
                  disabled={loading}
                  expanded={!!expanded[slot.slotId]}
                  onToggleExpand={() => setExpanded((e) => ({ ...e, [slot.slotId]: !e[slot.slotId] }))}
                  onReroll={() => void runPreview({ op: 'reroll-slot', slotId: slot.slotId })}
                  onPin={() => void runPreview({ op: 'pin', slotId: slot.slotId, pinned: !slot.pinned })}
                  onRemove={() => void runPreview({ op: 'remove-slot', slotId: slot.slotId })}
                  onCount={(count) => void runPreview({ op: 'adjust-count', slotId: slot.slotId, count })}
                />
              ))}
              {preview.roster.length === 0 && <p className="text-xs text-slate-400">{t('encounters.wizard.noCreatures')}</p>}
            </div>
          </fieldset>

          {/* ── Step 3: commit ── */}
          <fieldset className="space-y-3 border-0 p-0 m-0">
            <legend className="text-xs text-slate-400 font-semibold">{t('encounters.wizard.step3')}</legend>
            <Field
              idPrefix="gen-enc"
              name="name"
              label="Encounter name"
              labelClassName="text-xs text-slate-400"
              placeholder={`Generated ${preview.targetBand} encounter`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              optional
            />
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
              <Field idPrefix="gen-enc" name="locationId" as="select" label="Location" labelClassName="text-xs text-slate-400" selectClassName="cf-select text-xs w-full cf-density-xs" value={locationId} onChange={(e) => setLocationId(e.target.value)} optional>
                <option value="">{t('encounters.wizard.none')}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name ?? `#${l.id}`}
                  </option>
                ))}
              </Field>
              <Field idPrefix="gen-enc" name="questId" as="select" label="Quest" labelClassName="text-xs text-slate-400" selectClassName="cf-select text-xs w-full cf-density-xs" value={questId} onChange={(e) => setQuestId(e.target.value)} optional>
                <option value="">{t('encounters.wizard.none')}</option>
                {quests.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.title ?? `#${q.id}`}
                  </option>
                ))}
              </Field>
              <Field idPrefix="gen-enc" name="sessionId" as="select" label="Session" labelClassName="text-xs text-slate-400" selectClassName="cf-select text-xs w-full cf-density-xs" value={sessionId} onChange={(e) => setSessionId(e.target.value)} optional>
                <option value="">{t('encounters.wizard.none')}</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title || `Session ${s.number ?? s.id}`}
                  </option>
                ))}
              </Field>
            </div>
            <AudienceField value={audience} onChange={setAudience} entityLabel="encounter" name="gen-encounter-audience" />
            <p className="text-xs text-slate-400">
              After saving you can generate/select a battle map and place tokens on the encounter tracker.
            </p>
            <div className="flex gap-2 justify-end">
              <Btn ghost type="button" onClick={onCancel} disabled={committing}>
                Cancel
              </Btn>
              <Btn type="button" onClick={() => void commit()} disabled={!canCommit}>
                {committing ? 'Saving…' : 'Create encounter'}
              </Btn>
            </div>
          </fieldset>
        </>
      )}
    </Card>
  );
}

function DifficultyExplanationPanel({ preview }: { preview: EncounterPreview }) {
  const { t } = useTranslation();
  const e = preview.explanation;
  const tone = e.status === 'unsupported' || e.status === 'unknown' ? 'tag tag-outline' : 'tag tag-accent';
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--color-surface-2, rgba(255,255,255,0.03))' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={tone} style={{ fontSize: 11 }}>
          {e.label}
        </span>
        {preview.matchedBand ? null : (
          <span className="tag tag-neutral" style={{ fontSize: 10 }}>
            achieved {preview.explanation.band ?? preview.difficulty.label} (requested {preview.targetBand})
          </span>
        )}
        {/* Issue #1928: the target band still sizes the roster (5e-shaped count/CR heuristic) even
            when this rule system has no budget math of its own — label it, don't hide it. */}
        {preview.difficultySupport === 'heuristic' && (
          <span
            className="tag tag-outline"
            style={{ fontSize: 10 }}
            title={t('encounters.wizard.heuristicDifficultyHint', {
              defaultValue: "Target band sized by D&D 5e's XP budget — this rule system has no difficulty math of its own.",
            })}
          >
            {t('encounters.wizard.heuristicDifficultyBadge', { defaultValue: 'Target band: heuristic' })}
          </span>
        )}
      </div>
      <p className="text-sm text-slate-200 mt-1">{e.headline}</p>
      {e.detail.length > 0 && (
        <ul className="text-xs text-slate-400 mt-1 list-disc pl-4 space-y-0.5">
          {e.detail.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
      {preview.fallbacks.length > 0 && (
        <div className="mt-2 text-xs text-amber-300 space-y-1">
          {preview.fallbacks.map((f, i) => (
            <p key={i}>{f}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function WarningsPanel({ preview }: { preview: EncounterPreview }) {
  if (preview.warnings.length === 0) return null;
  return (
    <ul className="space-y-1">
      {preview.warnings.map((w, i) => (
        <li key={i} className="text-xs flex items-start gap-2">
          <span className={w.severity === 'warn' ? 'text-rose-400' : 'text-slate-400'}>
            <GameIcon slug={w.severity === 'warn' ? 'hazard-sign' : 'info'} size={UI_ICON_SIZE.xs} />
          </span>
          <span className={w.severity === 'warn' ? 'text-rose-300' : 'text-slate-400'}>{w.message}</span>
        </li>
      ))}
    </ul>
  );
}

function RosterSlotRow({
  slot,
  disabled,
  expanded,
  onToggleExpand,
  onReroll,
  onPin,
  onRemove,
  onCount,
}: {
  slot: EncounterRosterSlot;
  disabled: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onReroll: () => void;
  onPin: () => void;
  onRemove: () => void;
  onCount: (count: number) => void;
}) {
  const { t } = useTranslation();
  const insp = slot.inspection;
  return (
    <div className="rounded-lg border border-white/10 p-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="text-sm text-white font-medium inline-flex items-center gap-1"
          onClick={onToggleExpand}
          aria-expanded={expanded}
        >
          <GameIcon slug={expanded ? 'up-card' : 'card-random'} size={UI_ICON_SIZE.xs} />
          {slot.name}
        </button>
        {slot.pinned && (
          <Chip variant="active">
            <span className="inline-flex items-center gap-1">
              <GameIcon slug="pin" size={UI_ICON_SIZE.xs} /> Pinned
            </span>
          </Chip>
        )}
        {slot.source === 'homebrew' && (
          <span className="tag tag-accent text-3xs">{t('encounters.wizard.homebrewBadge', 'Homebrew')}</span>
        )}
        <span className="tag tag-neutral" style={{ fontSize: 10 }}>
          {slot.cr !== null ? `CR ${slot.cr}` : 'CR ?'} · {slot.xp} XP
        </span>
        <div className="ml-auto flex items-center gap-1">
          <label className="text-xs text-slate-400 inline-flex items-center gap-1">
            ×
            <input
              type="number"
              min={1}
              max={50}
              value={slot.count}
              disabled={disabled}
              onChange={(ev) => {
                const n = Number(ev.target.value);
                if (Number.isFinite(n) && n >= 1) onCount(n);
              }}
              className="cf-input !w-14 text-xs cf-density-xs"
              aria-label={`Count of ${slot.name}`}
            />
          </label>
          <Btn ghost type="button" onClick={onReroll} disabled={disabled} title="Reroll / swap this slot">
            Reroll
          </Btn>
          <Btn ghost type="button" onClick={onPin} disabled={disabled} title={slot.pinned ? 'Unpin' : 'Pin (survives reroll-all)'}>
            {slot.pinned ? 'Unpin' : 'Pin'}
          </Btn>
          <Btn ghost type="button" onClick={onRemove} disabled={disabled} title="Remove this slot" aria-label={`Remove ${slot.name}`}>
            <UIIcon name="close" size="xs" />
          </Btn>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 text-xs text-slate-300 grid gap-1">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {insp.armorClass !== null && <span>AC {insp.armorClass}</span>}
            {insp.hitPointsMax !== null && <span>HP {insp.hitPointsMax}</span>}
            {insp.size && <span>{insp.size}</span>}
            {insp.creatureType && <span>{insp.creatureType}</span>}
            {insp.speed && <span>Speed {insp.speed}</span>}
          </div>
          {insp.abilities.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-slate-400">
              {insp.abilities.map((a) => (
                <span key={a.name}>
                  {a.name} {a.value}
                </span>
              ))}
            </div>
          )}
          {insp.savingThrows.length > 0 && (
            <div className="text-slate-400">
              Saves: {insp.savingThrows.map((s) => `${s.name} ${s.value}`).join(', ')}
            </div>
          )}
          {insp.traits.map((t) => (
            <div key={t.name}>
              <span className="text-slate-200 font-medium">{t.name}.</span> {t.text}
            </div>
          ))}
          {insp.actions.map((a) => (
            <div key={a.name}>
              <span className="text-slate-200 font-medium">{a.name}.</span> {a.text}
            </div>
          ))}
          {!insp.hasStatblock && <p className="text-amber-300">{t('encounters.wizard.noStatblock')}</p>}
        </div>
      )}
    </div>
  );
}
