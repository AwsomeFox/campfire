import { useTranslation } from 'react-i18next';
/**
 * DM-initiated check requests (issue #415) — the interactive
 * DM-request → player-prompt → consequence loop, surfaced inside the run-session view.
 *
 * Three surfaces share this file:
 *  - {@link CheckRequestPanel} (DM only): pick one or more characters (or one-tap "whole party")
 *    and a catalog check, optionally a DC and consequence text, and send it. POSTs
 *    /campaigns/:id/check-requests, which persists one row per target sharing one `groupId`
 *    (issue #1943); each targeted player is nudged over SSE (a thin `check.requested` tick) to
 *    read it back and roll once.
 *  - {@link GroupCheckBoard} (DM only, issue #1943): one card per `groupId`, tallying
 *    pending/pass/fail per targeted character as the group's rows resolve, driven by the same
 *    `check.requested`/`check.resolved` SSE invalidations — no reload.
 *  - {@link CheckRequestPrompts} (the targeted player): renders an in-page prompt for every pending
 *    request against a character the viewer owns. Rolling posts /check-requests/:id/roll, which
 *    reuses the server-resolved catalog-roll path (shared dice log + transparent breakdown), and
 *    then shows the DM's consequence text alongside the outcome. Each request can be rolled ONCE.
 *
 * Live-region announcements route through the app-wide Announcer (useAnnounce) — never a second
 * aria-live region. Visible copy is scoped with data-testid to keep strict Playwright locators happy.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Character, CheckRequest, CheckRequestResolution, DiceRoll, RollCheckDefinition } from '@campfire/schema';
import { ruleSystemAdapter, groupCheckMajorityAdvisoryForAdapter } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { queryKeys, invalidateCampaignCheckRequests } from '../../lib/query';
import { Card, Btn, Chip, TextInput } from '../../components/ui';
import { useAnnounce } from '../../components/Announcer';
import { useCampaign } from '../../app/CampaignContext';
import { buildGroupCheckSummaries, groupCheckMajoritySucceeds, shouldShowPassedTally } from './groupCheckBoard';
import { CHECK_REQUEST_MAX_TARGETS, commonChecks, exceedsCheckRequestCap, wholePartyTargetIds } from './checkRequestComposer';

/**
 * Bounds the group-check board's own check-requests fetch (issue #1943 review): `listCheckRequests`
 * has no server-side default limit, and the board refetches on every `check.requested`/
 * `check.resolved` SSE invalidation for the life of the campaign — an unbounded page would grow
 * without end and get chattier the longer a campaign runs. 100 rows comfortably covers many
 * recent group sends (up to 20 characters each) while staying well clear of the dice-roll feed's
 * own 50-roll window, so a resolved group's roll is very unlikely to have aged out of both.
 */
const GROUP_CHECK_BOARD_REQUEST_LIMIT = 100;

/** Human summary of a resolved outcome for the announcer + result line. */
function outcomeText(res: CheckRequestResolution): string {
  const { roll } = res.result;
  const dc = roll.dc != null ? ` vs DC ${roll.dc}` : '';
  const pass = roll.dc != null ? (roll.success ? ' — success' : ' — failure') : '';
  const degree = res.result.degree ? ` (${res.result.degree})` : '';
  return `${res.result.check.label}: ${roll.total}${dc}${pass}${degree}`;
}

/**
 * DM control: request a check/save from one or more characters at once (issue #1943). A
 * checkbox per character (every character, any `status` — a DM can still hand-pick a retired or
 * dead sheet for an edge case like a flashback scene) plus a one-tap "whole party" preset, a
 * check picker, a DC and a consequence field. One box checked behaves exactly like the original
 * single-target flow. DM-only; the parent gates rendering on role.
 *
 * The check picker is the INTERSECTION of every selected character's own catalog (issue #1943
 * review #7), not just the first selected character's — that shortcut only happens to be safe
 * for 5e/PF2e, whose adapters implement `buildCheckCatalog` identically for every character.
 * Every other registered system (OSR, Open Legend, 13th Age, Starforged, homebrew) falls back to
 * `neutralCheckCatalog`, which derives `skill:*`/`ability:*`/`save:*` ids from THAT character's
 * own `stats`/`skills` keys — two party members can genuinely have different catalogs there, and
 * offering a check the DM's pick has but another target lacks would 404 that target after
 * already committing the others (see `requestChecks`'s own atomicity fix for the write-time
 * half of that). An empty intersection (no check every selected character can roll) shows an
 * explicit message rather than silently offering nothing.
 *
 * The "whole party" PRESET, unlike the checkboxes, is scoped to `status === 'active'` characters
 * only (issue #1943 review) — its entire purpose is "everyone currently playing," and it is
 * disabled with a visible reason once the active roster exceeds the server's 20-target cap
 * (`CheckRequestCreate.characterIds.max(20)`) rather than minting a request the server would 400.
 */
export function CheckRequestPanel({
  campaignId,
  characters,
  encounterId,
  onError,
}: {
  campaignId: number;
  characters?: Character[];
  encounterId?: number;
  onError?: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set());
  const [checkId, setCheckId] = useState('');
  const [dc, setDc] = useState('');
  const [consequence, setConsequence] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const campaignCharactersQuery = useQuery({
    queryKey: queryKeys.campaignCharacters(campaignId),
    queryFn: () => api.get<Character[]>(`${API}/campaigns/${campaignId}/characters`),
    enabled: Number.isFinite(campaignId) && !characters,
  });

  // Memoized so the `characters ?? [] ?? []` fallback doesn't mint a new array identity every
  // render — that would otherwise make `wholePartyIds` below recompute on every render too.
  const availableCharacters = useMemo(() => characters ?? campaignCharactersQuery.data ?? [], [characters, campaignCharactersQuery.data]);
  // "Whole party" means the characters currently playing, not every sheet the campaign has ever
  // created (issue #1943 review) — see checkRequestComposer.ts's doc comment. The individual
  // checkboxes below still list every character regardless of status; only this one-tap PRESET
  // is scoped to active ones.
  const wholePartyIds = useMemo(() => wholePartyTargetIds(availableCharacters), [availableCharacters]);
  const wholePartyTooLarge = exceedsCheckRequestCap(wholePartyIds);

  const toggleCharacter = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setCheckId('');
  };

  const selectWholeParty = () => {
    // Defense in depth: the button is already disabled past the cap below, but never mint a
    // characterIds array the server would 400 on regardless.
    if (wholePartyTooLarge) return;
    setSelectedIds(new Set(wholePartyIds));
    setCheckId('');
  };

  // Stable-ordered list of selected ids so useQueries' query array doesn't reshuffle every
  // render (Sets have no ordering guarantee across renders).
  const selectedCharacterIds = useMemo(() => Array.from(selectedIds).sort((a, b) => a - b), [selectedIds]);

  // One checks-catalog fetch PER selected character — see the doc comment above for why a
  // single representative's catalog is not safe to assume for every target.
  const checksQueries = useQueries({
    queries: selectedCharacterIds.map((id) => ({
      queryKey: ['characters', id, 'checks'],
      queryFn: () => api.get<RollCheckDefinition[]>(`${API}/characters/${id}/checks`),
    })),
  });
  const checksLoading = checksQueries.some((q) => q.isLoading);
  const checks = useMemo(() => {
    if (selectedCharacterIds.length === 0 || checksLoading) return [];
    return commonChecks(checksQueries.map((q) => q.data ?? []));
  }, [checksQueries, checksLoading, selectedCharacterIds.length]);
  // True once every selected character's catalog has loaded but they share no rollable check.
  const noCommonCheck = selectedCharacterIds.length > 0 && !checksLoading && checks.length === 0;

  const send = useMutation({
    mutationFn: () =>
      api.post<CheckRequest[]>(`${API}/campaigns/${campaignId}/check-requests`, {
        characterIds: Array.from(selectedIds),
        checkId,
        ...(dc.trim() ? { dc: Number(dc) } : {}),
        ...(consequence.trim() ? { consequence: consequence.trim() } : {}),
        ...(encounterId != null ? { encounterId } : {}),
      }),
    onMutate: () => {
      setLocalError(null);
      onError?.(null);
    },
    onSuccess: (created) => {
      const [first] = created;
      if (first) {
        const dcSuffix = first.dc != null ? ` at DC ${first.dc}` : '';
        announce(
          created.length === 1
            ? `Requested ${first.checkLabel} from ${first.characterName}${dcSuffix}.`
            : `Requested ${first.checkLabel} from ${created.length} characters${dcSuffix}.`,
        );
      }
      invalidateCampaignCheckRequests(queryClient, campaignId);
      setCheckId('');
      setDc('');
      setConsequence('');
    },
    onError: (err) => {
      const msg = translateApiError(err, t, { fallbackKey: 'encounters.errors.sendCheck' });
      setLocalError(msg);
      onError?.(msg);
    },
  });

  const canSend = selectedIds.size > 0 && checkId.trim().length > 0 && !send.isPending;

  return (
    <Card className="space-y-2.5" data-testid="request-check-panel">
      <span className="card-kicker">{t('encounters.checks.requestCheck')}</span>
      <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }}>
        Ask one or more players to roll a check or save. They get an in-page prompt and roll
        once; each result lands in the shared dice log with your consequence text.
      </p>
      {localError && <p className="text-sm text-rose-400">{localError}</p>}
      <div className="flex gap-2 flex-wrap items-end">
        <div className="field" style={{ flex: 2, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span id="check-request-targets-label">{t('encounters.checks.targets')}</span>
            <Btn
              type="button"
              ghost
              density="compact"
              disabled={wholePartyIds.length === 0 || wholePartyTooLarge}
              onClick={selectWholeParty}
              data-testid="check-request-whole-party"
              title={wholePartyTooLarge ? t('encounters.checks.wholePartyTooLarge', { count: wholePartyIds.length, max: CHECK_REQUEST_MAX_TARGETS }) : undefined}
            >
              {t('encounters.checks.wholeParty', { count: wholePartyIds.length })}
            </Btn>
          </div>
          {wholePartyTooLarge && (
            <p className="text-muted" style={{ fontSize: 12 }} data-testid="check-request-whole-party-too-large">
              {t('encounters.checks.wholePartyTooLarge', { count: wholePartyIds.length, max: CHECK_REQUEST_MAX_TARGETS })}
            </p>
          )}
          {availableCharacters.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 12 }}>{t('encounters.checks.noCharacters')}</p>
          ) : (
            <div
              role="group"
              aria-labelledby="check-request-targets-label"
              style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 130, overflowY: 'auto' }}
            >
              {availableCharacters.map((c) => (
                <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={() => toggleCharacter(c.id)}
                    data-testid={`check-request-target-${c.id}`}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label htmlFor="check-request-check">{t('encounters.checks.check')}</label>
          <select
            id="check-request-check"
            className="cf-select"
            value={checkId}
            disabled={selectedCharacterIds.length === 0 || checksLoading || noCommonCheck}
            onChange={(e) => setCheckId(e.target.value)}
          >
            <option value="">
              {selectedCharacterIds.length === 0
                ? t('encounters.checks.pickCharacterFirst')
                : noCommonCheck
                  ? t('encounters.checks.noCommonCheck')
                  : t('encounters.checks.chooseCheck')}
            </option>
            {checks.map((def) => (
              <option key={def.id} value={def.id}>
                {def.label}
              </option>
            ))}
          </select>
          {noCommonCheck && (
            <p className="text-muted" style={{ fontSize: 12 }} data-testid="check-request-no-common-check">
              {t('encounters.checks.noCommonCheckHint')}
            </p>
          )}
        </div>
        <div className="field" style={{ width: 80 }}>
          <label htmlFor="check-request-dc">{t('encounters.checks.dc')}</label>
          <TextInput
            id="check-request-dc"
            type="number"
            min={1}
            max={99}
            placeholder="15"
            value={dc}
            onChange={(e) => setDc(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="check-request-consequence">{t('encounters.checks.consequenceOptional')}</label>
        <TextInput
          id="check-request-consequence"
          placeholder="On a failure, the bridge gives way…"
          value={consequence}
          maxLength={500}
          onChange={(e) => setConsequence(e.target.value)}
        />
      </div>
      <div>
        <Btn disabled={!canSend} onClick={() => send.mutate()}>
          {send.isPending ? 'Sending…' : 'Send request'}
        </Btn>
      </div>
    </Card>
  );
}

/**
 * DM results board (issue #1943): one card per `groupId`, listing each targeted character's
 * pending/pass/fail state and a live "X of N" tally, so a party-wide save no longer dissolves
 * into scrollback — the DM reads the outcome at a glance instead of tallying by hand.
 *
 * DM-only (the parent gates rendering on role, same as {@link CheckRequestPanel}); the visibility
 * scoping that keeps a player from seeing another player's rows lives entirely server-side in
 * `listCheckRequests` — this component adds no client-side widening, it just groups+tallies
 * whatever the campaign's DM-scoped feed already returns.
 *
 * Per-character pass/fail is recovered by joining each resolved row's `rollId` against the
 * shared dice-roll feed (`GET /campaigns/:id/rolls`, the same one `SharedDiceLog` renders) —
 * `CheckRequest` itself only carries the REQUESTED dc, not the roll's outcome. See
 * `groupCheckBoard.ts` for the pure grouping/tally logic.
 *
 * Reads a bounded, board-owned request page under `queryKeys.campaignCheckRequestsAll` — NOT
 * the plain `campaignCheckRequests` key, which `CheckRequestPrompts` already owns app-wide with
 * a `?status=pending`-only `queryFn` (issue #1943 review: two components sharing one React
 * Query key with different `queryFn`s let either one silently serve the other's cached payload).
 */
export function GroupCheckBoard({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const campaign = useCampaign(campaignId);
  const adapterHasMajorityAdvisory = groupCheckMajorityAdvisoryForAdapter(ruleSystemAdapter(campaign?.ruleSystem));

  const requestsQuery = useQuery({
    queryKey: queryKeys.campaignCheckRequestsAll(campaignId),
    queryFn: () => api.get<CheckRequest[]>(`${API}/campaigns/${campaignId}/check-requests?limit=${GROUP_CHECK_BOARD_REQUEST_LIMIT}`),
    enabled: Number.isFinite(campaignId),
  });
  const rollsQuery = useQuery({
    queryKey: queryKeys.campaignDiceLog(campaignId),
    queryFn: () => api.get<DiceRoll[]>(`${API}/campaigns/${campaignId}/rolls?limit=50`),
    enabled: Number.isFinite(campaignId),
  });

  // A page exactly at the requested limit means older rows may exist beyond it — see
  // buildGroupCheckSummaries's doc comment on `hasMoreOlderRows` for why this is the one signal
  // that flags a possibly-split group (issue #1943 review).
  const hasMoreOlderRows = (requestsQuery.data?.length ?? 0) === GROUP_CHECK_BOARD_REQUEST_LIMIT;
  const summaries = useMemo(
    () => buildGroupCheckSummaries(requestsQuery.data ?? [], rollsQuery.data ?? [], hasMoreOlderRows),
    [requestsQuery.data, rollsQuery.data, hasMoreOlderRows],
  );

  if (summaries.length === 0) return null;

  return (
    <Card className="space-y-2.5" data-testid="group-check-board">
      <span className="card-kicker">{t('encounters.checks.board.title')}</span>
      {summaries.map((summary) => {
        const succeeds = groupCheckMajoritySucceeds(summary, adapterHasMajorityAdvisory);
        return (
          <div key={summary.groupId} className="cf-inset" data-testid={`group-check-${summary.groupId}`} style={{ padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <strong>{summary.checkLabel}</strong>
              <span className="text-muted" style={{ fontSize: 12 }} data-testid={`group-check-tally-${summary.groupId}`}>
                {summary.possiblyIncomplete
                  ? t('encounters.checks.board.possiblyIncomplete')
                  : shouldShowPassedTally(summary)
                    ? t('encounters.checks.board.tallyPassed', { pass: summary.passCount, total: summary.totalCount })
                    : t('encounters.checks.board.tallyResolved', { resolved: summary.resolvedCount, total: summary.totalCount })}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
              {summary.members.map((member) => (
                <div key={member.characterId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                  <span>{member.characterName}</span>
                  {member.status === 'pending' ? (
                    <Chip variant="neutral" density="compact">{t('encounters.checks.board.pending')}</Chip>
                  ) : member.success === true ? (
                    <Chip variant="completed" density="compact">{t('encounters.checks.board.passed')}</Chip>
                  ) : member.success === false ? (
                    <Chip variant="failed" density="compact">{t('encounters.checks.board.failed')}</Chip>
                  ) : (
                    <Chip variant="neutral" density="compact">{t('encounters.checks.board.resolved')}</Chip>
                  )}
                </div>
              ))}
            </div>
            {succeeds && (
              <p className="text-muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }} data-testid={`group-check-advisory-${summary.groupId}`}>
                {t('encounters.checks.board.majoritySucceeds')}
              </p>
            )}
          </div>
        );
      })}
    </Card>
  );
}

/** One pending prompt for the targeted player: shows the ask + consequence, rolls once. */
function PromptCard({
  request,
  onResolved,
  onError,
}: {
  request: CheckRequest;
  onResolved: (res: CheckRequestResolution) => void;
  onError?: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const [localError, setLocalError] = useState<string | null>(null);

  const roll = useMutation({
    mutationFn: () => api.post<CheckRequestResolution>(`${API}/check-requests/${request.id}/roll`, {}),
    onMutate: () => {
      setLocalError(null);
      onError?.(null);
    },
    onSuccess: (res) => {
      announce(outcomeText(res));
      invalidateCampaignCheckRequests(queryClient, request.campaignId);
      onResolved(res);
    },
    onError: (err) => {
      const msg = translateApiError(err, t, { fallbackKey: 'encounters.errors.rollCheck' });
      setLocalError(msg);
      onError?.(msg);
    },
  });

  return (
    <div
      className="cf-inset"
      data-testid={`check-request-prompt-${request.id}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: 'var(--color-text)' }}>{request.characterName}</span>
        <span className="text-muted" style={{ fontSize: 12 }}>
          {request.requestedByName || 'The DM'} asks for a roll
        </span>
      </div>
      <div style={{ fontSize: 13 }}>
        <strong>{request.checkLabel}</strong>
        {request.dc != null ? <span className="text-muted"> · DC {request.dc}</span> : null}
      </div>
      {request.consequence && (
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }} data-testid={`check-request-consequence-${request.id}`}>
          {request.consequence}
        </p>
      )}
      {localError && <p className="text-sm text-rose-400">{localError}</p>}
      <div>
        <Btn
          disabled={roll.isPending}
          onClick={() => roll.mutate()}
          data-testid={`check-request-roll-${request.id}`}
          aria-label={`Roll ${request.checkLabel} for ${request.characterName}`}
        >
          {roll.isPending ? 'Rolling…' : 'Roll'}
        </Btn>
      </div>
    </div>
  );
}

/** The resolved result the player just rolled — total, pass/fail, and the DM's consequence text. */
function ResultCard({ resolution }: { resolution: CheckRequestResolution }) {
  const { t } = useTranslation();
  const { request, result } = resolution;
  return (
    <div
      className="cf-inset"
      data-testid={`check-request-result-${request.id}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: 'var(--color-text)' }}>{request.characterName}</span>
        <span className="text-muted" style={{ fontSize: 12 }}>{result.check.label}</span>
      </div>
      <div style={{ fontSize: 13 }}>
        <span>{t('encounters.checks.rolled')}</span>
        <strong style={{ color: 'var(--color-accent)' }}>{result.roll.total}</strong>
        {result.roll.dc != null && (
          <span
            style={{ marginLeft: 6, fontWeight: 600, color: result.roll.success ? 'var(--color-success, #4ade80)' : 'var(--color-danger, #f87171)' }}
          >
            {result.roll.success ? 'Success' : 'Failure'}
          </span>
        )}
        {result.degree && <span className="text-muted" style={{ marginLeft: 6 }}>({result.degree})</span>}
      </div>
      <span className="text-muted" style={{ fontSize: 11.5 }}>{result.check.breakdownText}</span>
      {request.consequence && (
        <p style={{ fontSize: 12, margin: 0 }} data-testid={`check-request-result-consequence-${request.id}`}>
          <span className="text-muted">{t('encounters.checks.consequence')}</span>
          {request.consequence}
        </p>
      )}
    </div>
  );
}

/**
 * The targeted player's in-page prompts. Renders one prompt per pending request against a
 * character the viewer owns; once rolled, the prompt is replaced by a result card showing the
 * outcome + consequence (kept locally so it survives the request leaving the pending feed).
 */
export function CheckRequestPrompts({
  campaignId,
  ownedCharacterIds,
  onError,
}: {
  campaignId: number;
  ownedCharacterIds?: ReadonlySet<number>;
  onError?: (msg: string | null) => void;
}) {
  const [resolved, setResolved] = useState<Record<number, CheckRequestResolution>>({});

  const pendingQuery = useQuery({
    queryKey: queryKeys.campaignCheckRequests(campaignId),
    queryFn: () => api.get<CheckRequest[]>(`${API}/campaigns/${campaignId}/check-requests?status=pending`),
    enabled: Number.isFinite(campaignId),
    refetchInterval: 15_000,
  });

  const mine = useMemo(
    () =>
      (pendingQuery.data ?? []).filter(
        (r) => (ownedCharacterIds ? ownedCharacterIds.has(r.characterId) : true) && r.status === 'pending',
      ),
    [pendingQuery.data, ownedCharacterIds],
  );

  const pendingPrompts = mine.filter((r) => resolved[r.id] == null);
  const results = Object.values(resolved);

  if (pendingPrompts.length === 0 && results.length === 0) return null;

  return (
    <div data-testid="check-request-prompts" className="flex flex-col gap-2 max-w-7xl mx-auto px-4 pt-3 pb-1 w-full">
      {pendingPrompts.map((request) => (
        <PromptCard
          key={request.id}
          request={request}
          onError={onError}
          onResolved={(res) => setResolved((prev) => ({ ...prev, [request.id]: res }))}
        />
      ))}
      {results.map((res) => (
        <ResultCard key={res.request.id} resolution={res} />
      ))}
    </div>
  );
}

