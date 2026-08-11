/**
 * NPC roster — mirrors design/claude-design/Campfire.dc.html "World" NPC tab (~1239-1258):
 * a compact card grid, avatar + name/role, disposition badge + last-seen location.
 * DM can inline-create (name + role); everyone can browse & open a detail page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { EntityCard } from '../../components/EntityCard';
import { cardExcerpt } from '../../lib/cardExcerpt';
import { useRestoreListOriginScroll } from '../../hooks/useRestoreListOriginScroll';
import type { Location, Npc } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Card, Chip, Btn, TextInput, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { AudienceField, audienceToHidden, type AudienceValue } from '../../components/AudienceField';
import { NpcDispositionBadge } from '../../components/EntitySemanticBadges';
import { PageHeader, type PageHeaderSecondaryAction } from '../../components/PageHeader';
import { GameIcon } from '../../components/GameIcon';
import { usePageHeaderDraftWithAi } from '../ai-dm/usePageHeaderDraftWithAi';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

export default function NpcListPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isDm, canDmWrite } = useCampaignAccess();
  useRestoreListOriginScroll();

  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(() => searchParams.get('action') === 'new');

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
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  // #754: quick-create defaults to DM-only.
  const [audience, setAudience] = useState<AudienceValue>('dm');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const { secondaryAction: draftAction, draftDialog } = usePageHeaderDraftWithAi({
    campaignId: id,
    target: 'npc',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [npcData, locationData] = await Promise.all([
        api.get<Npc[]>(`${API}/campaigns/${id}/npcs`),
        api.get<Location[]>(`${API}/campaigns/${id}/locations`),
      ]);
      setNpcs(npcData);
      setLocations(locationData);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load NPCs.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const locationName = useMemo(() => {
    const byId = new Map(locations.map((l) => [l.id, l.name]));
    return (locationId: number | null) => (locationId ? byId.get(locationId) : undefined);
  }, [locations]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  async function createNpc() {
    if (!newName.trim()) return;
    setSaving(true);
    setCreateError(null);
    try {
      const hidden = audienceToHidden(audience);
      const npc = await api.post<Npc>(`${API}/campaigns/${id}/npcs`, {
        name: newName.trim(),
        role: newRole.trim(),
        hidden,
      });
      setNewName('');
      setNewRole('');
      setAudience('dm');
      closeCreating();
      await load();
      navigate(`/c/${id}/npcs/${npc.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create the NPC.");
    } finally {
      setSaving(false);
    }
  }

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (loading && npcs.length === 0 && !error) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <Card>
          <Skeleton lines={5} />
        </Card>
      </div>
    );
  }

  if (error && npcs.length === 0) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  const secondaryActions: PageHeaderSecondaryAction[] = draftAction ? [draftAction] : [];

  return (
    <div data-testid="npc-list-surface" className="max-w-7xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      {/* No outer Card. This page used to nest its whole grid inside one, with the header
          in `variant="card"` to match — cards inside a card, a shell none of the other
          list pages (Quests, Sessions, Encounters, Inventory, Party, Library) use, so
          moving between Quests and NPCs changed the page's entire frame for no reason the
          content justified. The `card` PageHeader variant is retained for headers that
          genuinely do sit inside a card. */}
      <PageHeader
        icon={<GameIcon slug="hooded-figure" size={UI_ICON_SIZE.md} />}
        title={t('nav.npcs')}
        secondaryActions={secondaryActions}
        primaryAction={
          canDmWrite && !creating ? (
            <Btn ghost type="button" className="cf-page-header__action" onClick={() => setCreating(true)}>
              + New NPC
            </Btn>
          ) : undefined
        }
      />
      {draftDialog}

      {canDmWrite && creating && (
        <div className="cf-inset p-3.5 space-y-2">
          {createError && <ErrorNote message={createError} />}
          <TextInput aria-label="NPC name" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} autoFocus />
          <TextInput aria-label="NPC role" placeholder="Role (e.g. Townmaster)" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
          <AudienceField value={audience} onChange={setAudience} entityLabel="NPC" name="npc-audience" />
          <div className="flex items-center justify-end gap-2">
            <Btn density="xs"
              ghost
              className="text-xs"
              onClick={() => {
                closeCreating();
                setNewName('');
                setNewRole('');
                setAudience('dm');
                setCreateError(null);
              }}
            >
              Cancel
            </Btn>
            <Btn density="xs" className="text-xs" disabled={saving || !newName.trim()} onClick={createNpc}>
              {saving ? 'Creating…' : 'Create'}
            </Btn>
          </div>
        </div>
      )}

      {npcs.length === 0 ? (
        <EmptyState icon="hooded-figure" title="No NPCs yet" hint={isDm ? 'Add the first one above.' : 'The DM has not added any NPCs yet.'} />
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
          {npcs.map((npc) => (
            <EntityCard
              key={npc.id}
              to={`/c/${id}/npcs/${npc.id}`}
              className="cf-card-hover"
              title={npc.name}
              aria-label={`NPC: ${npc.name}`}
              nameClassName="font-bold text-slate-200 text-sm truncate cf-name-reveal"
              /* className="font-bold text-slate-200 text-sm truncate cf-name-reveal" */
              subtitle={npc.role}
              portraitUrl={npc.portraitUrl}
              iconSlug={npc.iconSlug}
              badges={
                <>
                  <NpcDispositionBadge disposition={npc.disposition} />
                  {isDm && npc.hidden && <Chip variant="failed"><span className="inline-flex items-center gap-1"><GameIcon slug="sight-disabled" size={UI_ICON_SIZE.xs} /> Hidden</span></Chip>}
                  {isDm && npc.dmSecret && <Chip variant="proposal">DM secret</Chip>}
                  {locationName(npc.locationId) && (
                    <span className="text-[11px] text-slate-400 ml-auto">{locationName(npc.locationId)}</span>
                  )}
                </>
              }
            >
              {/* Same two-line hook the quest list shows. The card carried initials, a
                  name and a disposition chip, so an NPC roster was a wall of near
                  identical tiles. `body` is the player-visible description — `dmSecret`
                  is separately chipped above and hidden NPCs are not returned to
                  non-DMs at all — so this exposes nothing new. */}
              {cardExcerpt(npc.body) && (
                /* `aria-hidden`, because EntityCard wraps the WHOLE card in one link. The
                   CSS clamp only limits painting, so without this the anchor's accessible
                   name became the name plus the entire body — up to 50k characters of
                   markdown — and a screen-reader user would sit through the full
                   description of every NPC to reach the next one. The preview is a visual
                   scanning aid; the body itself is on the page this link leads to. */
                <p className="cf-card-excerpt" aria-hidden="true">
                  {cardExcerpt(npc.body)}
                </p>
              )}
            </EntityCard>
          ))}
        </div>
      )}
    </div>
  );
}
