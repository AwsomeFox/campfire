/**
 * AI-DM grounding review card (issue #577) — mounted at the table, under the stuck banner.
 *
 * The server splits the driver's output into creative narration (ungated, the DM's job) and
 * FACTUAL CLAIMS — rules rulings and assertions about existing canon. A factual claim is only
 * `supported` when every id it cited was actually returned by an authorized, campaign-scoped
 * read during that same turn. This card is where an `unsupported` claim becomes visible instead
 * of being quietly accepted as authoritative narration.
 *
 * Two deliberate choices worth knowing when reading this:
 *   - It shows the claim, never a rewritten narration. The transcript keeps every word the AI
 *     said; this card labels it. Deleting text the table already watched is worse than marking it.
 *   - The provenance line is the provider NAME and served model id only. Those are the sole
 *     provider details the server ever puts on the wire — no key, base URL, or headers exist in
 *     this payload to leak.
 *
 * Members read; only the DM may correct (the server enforces both). A correction is replayed
 * into every later turn's system prompt as table-authoritative, so the model stops repeating it.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API, translateApiError } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { Btn, TextArea } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

/** One validated source reference as the server returns it. */
export interface GroundingCitation {
  type: string;
  id: number;
  status: 'supported' | 'unsupported';
  reason: string;
  retrievedBy?: string;
  href?: string;
  /**
   * The server withheld this citation's id and evidence link because the backing entity is
   * DM-only — a hidden encounter, or an entity behind a #557 secret-read approval (#825). The
   * verdict is still shown; only the source's identity is hidden. `id` arrives as 0.
   */
  redacted?: boolean;
}

/** One claim plus the server's verdict, from GET /ai-dm/grounding. */
export interface GroundingClaimRecord {
  id: number;
  campaignId: number;
  turn: number;
  claimIndex: number;
  kind: string;
  claimText: string;
  status: 'supported' | 'unsupported' | 'corrected';
  reason: string;
  citations: GroundingCitation[];
  provider: string;
  model: string;
  createdAt: string;
  correction: string | null;
  correctedBy: string | null;
  correctedAt: string | null;
}

/** How many claims the card shows before the "older claims" affordance. */
const VISIBLE_CLAIMS = 5;

interface GroundingPanelProps {
  campaignId: number;
  isDm: boolean;
}

export function GroundingPanel({ campaignId, isDm }: GroundingPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claimsQuery = useQuery({
    queryKey: queryKeys.aiDmGrounding(campaignId),
    queryFn: () => api.get<GroundingClaimRecord[]>(`${API}/campaigns/${campaignId}/ai-dm/grounding`),
  });

  const claims = claimsQuery.data ?? [];
  // A supported claim is the system working; the card exists for the ones a human should look
  // at. Corrected claims stay listed so the table can see the ruling that superseded them.
  const needsAttention = claims.filter((c) => c.status !== 'supported');
  if (needsAttention.length === 0) return null;
  const shown = expanded ? needsAttention : needsAttention.slice(0, VISIBLE_CLAIMS);
  const unverifiedCount = needsAttention.filter((c) => c.status === 'unsupported').length;

  async function submitCorrection(claimId: number) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/ai-dm/grounding/correct`, {
        claimId,
        correction: draft.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiDmGrounding(campaignId) });
      setEditing(null);
      setDraft('');
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="cf-inset p-4 flex flex-col gap-3"
      style={{ borderColor: 'var(--color-amber, #f59e0b)', background: 'color-mix(in srgb, var(--color-amber, #f59e0b) 7%, transparent)' }}
      role="region"
      aria-label={t('table.grounding.title')}
    >
      <div className="flex items-start gap-2">
        <span className="flex text-lg"><GameIcon slug="magnifying-glass" size={UI_ICON_SIZE.md} /></span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--color-text)]">
            {unverifiedCount > 0
              ? t('table.grounding.titleUnverified', { count: unverifiedCount })
              : t('table.grounding.title')}
          </p>
          <p className="text-xs text-[var(--color-neutral-400)] mt-0.5">{t('table.grounding.hint')}</p>
        </div>
      </div>

      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {shown.map((claim) => (
          <li key={claim.id} className="cf-inset p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="text-[11px] uppercase tracking-wide px-1.5 py-0.5 rounded"
                style={{
                  background:
                    claim.status === 'corrected'
                      ? 'color-mix(in srgb, var(--color-accent) 20%, transparent)'
                      : 'color-mix(in srgb, var(--color-amber, #f59e0b) 22%, transparent)',
                }}
              >
                {claim.status === 'corrected' ? t('table.grounding.corrected') : t('table.grounding.unverified')}
              </span>
              <span className="text-[11px] text-secondary">
                {t(`table.grounding.kind.${claim.kind}`, { defaultValue: claim.kind })}
              </span>
              <span className="text-[11px] text-secondary">
                {t(`table.grounding.reason.${claim.reason}`, { defaultValue: claim.reason })}
              </span>
            </div>

            <p className="text-sm text-[var(--color-neutral-200)]">“{claim.claimText}”</p>

            {/* Provenance: provider name + served model. Nothing else about the provider
                reaches this client, so there is no secret here to redact. */}
            <p className="text-[11px] text-secondary">
              {t('table.grounding.provenance', {
                provider: claim.provider || t('table.grounding.unknownProvider'),
                model: claim.model || t('table.grounding.unknownModel'),
                turn: claim.turn,
              })}
            </p>

            {claim.citations.length > 0 && (
              <ul className="flex flex-wrap gap-2 list-none p-0 m-0">
                {claim.citations.map((cite, i) => (
                  <li key={`${cite.type}:${cite.id}:${i}`} className="text-[11px]">
                    {cite.redacted ? (
                      // No id and no link: rendering "npc #0" would be noise, and the whole point
                      // is that this reader may not know WHICH entity backed the claim.
                      <span className="text-secondary">
                        {cite.type} — {t('table.grounding.dmOnlySource')}
                      </span>
                    ) : cite.href && cite.status === 'supported' ? (
                      <Link to={cite.href} className="underline">
                        {cite.type} #{cite.id}
                      </Link>
                    ) : (
                      <span className="text-secondary">
                        {cite.type} #{cite.id} —{' '}
                        {t(`table.grounding.reason.${cite.reason}`, { defaultValue: cite.reason })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {claim.correction && (
              <p className="text-xs text-[var(--color-text)]">
                <strong>{t('table.grounding.correctionLabel')}</strong> {claim.correction}
              </p>
            )}

            {isDm && claim.status !== 'corrected' && (
              editing === claim.id ? (
                <div className="flex flex-col gap-2">
                  <TextArea
                    rows={2}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={t('table.grounding.correctPlaceholder')}
                    aria-label={t('table.grounding.correctPlaceholder')}
                  />
                  <div className="flex gap-2">
                    <Btn onClick={() => void submitCorrection(claim.id)} disabled={busy || draft.trim() === ''}>
                      {t('table.grounding.correctSubmit')}
                    </Btn>
                    <Btn onClick={() => { setEditing(null); setDraft(''); }} disabled={busy}>
                      {t('table.grounding.cancel')}
                    </Btn>
                  </div>
                </div>
              ) : (
                <div>
                  <Btn onClick={() => { setEditing(claim.id); setDraft(''); setError(null); }}>
                    {t('table.grounding.correct')}
                  </Btn>
                </div>
              )
            )}
          </li>
        ))}
      </ul>

      {needsAttention.length > VISIBLE_CLAIMS && (
        <div>
          <Btn onClick={() => setExpanded((v) => !v)}>
            {expanded
              ? t('table.grounding.showFewer')
              : t('table.grounding.showAll', { count: needsAttention.length })}
          </Btn>
        </div>
      )}

      {error && <p className="text-xs" style={{ color: 'var(--color-danger)' }} role="alert">{error}</p>}
    </div>
  );
}
