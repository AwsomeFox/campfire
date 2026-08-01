import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CampaignSummary, Role, Campaign, Encounter } from '@campfire/schema';

type DangerLevel = Campaign['dangerLevel'];
import { api, API, ApiError } from '../../lib/api';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useUnsavedWork } from '../../lib/useUnsavedWork';
import { formatCampaignSessionPosition } from '../../lib/sessionPosition';
import { Card, Btn } from '../../components/ui';
import { CampaignMetadataFields, isCampaignMetadataDirty } from '../../components/CampaignMetadataFields';
import { AiModeBadge } from '../ai-dm/AiModeBadge';
import { GameIcon } from '../../components/GameIcon';
import { CampaignCover } from '../../components/CampaignCover';
import { PageTitle } from '../../components/PageTitle';
import { TermHelp } from '../../components/TermHelp';
import { useSaveFeedback } from '../../components/SaveFeedback';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

const DANGER_LABEL: Record<DangerLevel, string> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  deadly: 'Deadly',
};

export function StatusHeader({
  campaignId,
  summary,
  role,
  onChange,
  liveEncounter,
}: {
  campaignId: number;
  summary: CampaignSummary;
  role: Role | null;
  onChange: () => void;
  liveEncounter?: Encounter | null;
}) {
  const isDm = role === 'dm';
  const { canDmWrite } = useCampaignAccess();
  const { campaign, currentLocation } = summary;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [description, setDescription] = useState(campaign.description);
  const [dangerLevel, setDangerLevel] = useState<DangerLevel>(campaign.dangerLevel);
  // Local baseline so a successful PATCH clears dirty even if the parent summary
  // reload is slow or fails (DashboardPage fires load() without awaiting it).
  const [baseline, setBaseline] = useState({
    name: campaign.name,
    description: campaign.description,
    dangerLevel: campaign.dangerLevel,
  });
  const feedback = useSaveFeedback('Campaign details');
  const saving = feedback.state === 'saving';

  // Inline editor and Settings share the same durable explicit-save lifecycle.
  const dirty = isCampaignMetadataDirty(baseline, { name, description, dangerLevel });
  // Issue #760: block Switch campaign while the inline dashboard editor is dirty.
  useUnsavedWork(`dashboard-metadata:${campaignId}`, editing && dirty);

  function startEdit() {
    const nextBaseline = {
      name: campaign.name,
      description: campaign.description,
      dangerLevel: campaign.dangerLevel,
    };
    setBaseline(nextBaseline);
    setName(nextBaseline.name);
    setDescription(nextBaseline.description);
    setDangerLevel(nextBaseline.dangerLevel);
    feedback.reset();
    setEditing(true);
  }

  function cancel() {
    // Reset to the live campaign prop so reopening never shows stale edits (issue #750).
    setName(campaign.name);
    setDescription(campaign.description);
    setDangerLevel(campaign.dangerLevel);
    feedback.reset();
    setEditing(false);
  }

  async function save() {
    if (!name.trim()) {
      feedback.fail('Campaign name is required.');
      return;
    }
    if (saving) return;
    feedback.begin();
    try {
      const updated = await api.patch<Campaign>(`${API}/campaigns/${campaignId}`, {
        name: name.trim(),
        description,
        dangerLevel,
      });
      // Re-baseline from the persisted response before claiming Saved — do not
      // wait on the fire-and-forget parent reload.
      const nextBaseline = {
        name: updated.name,
        description: updated.description,
        dangerLevel: updated.dangerLevel,
      };
      setBaseline(nextBaseline);
      setName(nextBaseline.name);
      setDescription(nextBaseline.description);
      setDangerLevel(nextBaseline.dangerLevel);
      feedback.succeed();
      onChange();
    } catch (err) {
      // Preserve the in-flight values on failure so a transient 5xx doesn't
      // silently discard what the DM typed (issue #750 acceptance criterion).
      feedback.fail(err instanceof ApiError ? err.message : "Couldn't save changes.");
    }
  }

  if (editing) {
    return (
      <Card density="compact" elev="sm" style={{ padding: 16 }} aria-label="Edit campaign details">
        <CampaignMetadataFields
          idPrefix="dashboard-campaign"
          name={name}
          description={description}
          dangerLevel={dangerLevel}
          onNameChange={(value) => { setName(value); feedback.syncDirty(isCampaignMetadataDirty(baseline, { name: value, description, dangerLevel })); }}
          onDescriptionChange={(value) => { setDescription(value); feedback.syncDirty(isCampaignMetadataDirty(baseline, { name, description: value, dangerLevel })); }}
          onDangerLevelChange={(value) => { setDangerLevel(value); feedback.syncDirty(isCampaignMetadataDirty(baseline, { name, description, dangerLevel: value })); }}
          describedBy={feedback.statusId}
          disabled={saving}
        />
        <div className="flex gap-2 justify-end items-center">
          {feedback.announcement}
          <Btn ghost onClick={cancel} disabled={saving}>
            Cancel
          </Btn>
          <Btn onClick={save} disabled={saving || !name.trim() || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </Btn>
        </div>
      </Card>
    );
  }

  // Design: header row is just the campaign name + a wrapped chip row
  // (session, danger, location) — no boxed card. See Campfire.dc.html ~L417-425.
  return (
    <section className="cf-brand-scene" aria-label="Campaign overview">
      <CampaignCover
        campaignId={campaignId}
        name={campaign.name}
        variant="banner"
        className="cf-brand-scene__cover"
        showMonogram={false}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px', marginTop: 12 }}>
      {/* Issue #1711: this was an <h3> wearing PageTitle's CSS class with a hand-set
          fontSize — the Dashboard route shipped no real <h1> at all. `size="compact"`
          is the documented variant that preserves the same 1.35rem this inline row
          has always used (a title sharing space with session/danger/location chips,
          not standing alone atop the page) — see PageTitle.tsx and index.css. */}
      <PageTitle size="compact" style={{ margin: 0 }}>{campaign.name}</PageTitle>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {liveEncounter && (
          <Link
            to={`/c/${campaignId}/encounters/${liveEncounter.id}`}
            className="tag tag-accent"
            style={{ whiteSpace: 'nowrap', cursor: 'pointer', textDecoration: 'none' }}
          >
            Live · Round {liveEncounter.round}
          </Link>
        )}
        <span className="tag tag-neutral" style={{ whiteSpace: 'nowrap' }}>
          {formatCampaignSessionPosition(campaign)}
        </span>
        <span className="tag tag-accent" style={{ whiteSpace: 'nowrap' }}>
          {DANGER_LABEL[campaign.dangerLevel]} danger
        </span>
        {/* Mode-aware chrome (#343): tells everyone an AI participates before it speaks. */}
        <AiModeBadge campaignId={campaignId} />
        <span className="tag tag-outline" style={{ whiteSpace: 'nowrap' }}>
          {currentLocation ? (
            <Link
              to={`/c/${campaignId}/locations/${currentLocation.id}`}
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              {currentLocation.name}
            </Link>
          ) : (
            'Location unset'
          )}
        </span>
        {isDm && (
          <>
            {/* No aria-label / title here: the visible word "Cast" is the
                accessible name, and the adjacent TermHelp carries the
                explanation without a hover-only tooltip (issue #518). */}
            <Link
              to={`/c/${campaignId}/screen`}
              className="btn btn-ghost"
              style={{ fontSize: 12, textDecoration: 'none' }}
            >
              <GameIcon slug="tv" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />Cast
            </Link>
            <TermHelp termId="cast" />
            {canDmWrite && (
            <Btn ghost style={{ fontSize: 12 }} title="DM only" onClick={startEdit}>
              ✎ Edit
            </Btn>
            )}
          </>
        )}
      </div>
      {feedback.announcement}
      </div>
    </section>
  );
}
