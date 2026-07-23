import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CampaignSummary, Role, Campaign, Encounter } from '@campfire/schema';

type DangerLevel = Campaign['dangerLevel'];
import { api, API, ApiError } from '../../lib/api';
import { formatCampaignSessionPosition } from '../../lib/sessionPosition';
import { useUnsavedWork } from '../../lib/useUnsavedWork';
import { Btn } from '../../components/ui';
import { CampaignMetadataFields, isCampaignMetadataDirty } from '../../components/CampaignMetadataFields';
import { AiModeBadge } from '../ai-dm/AiModeBadge';
import { GameIcon } from '../../components/GameIcon';

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
  const { campaign, currentLocation } = summary;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [description, setDescription] = useState(campaign.description);
  const [dangerLevel, setDangerLevel] = useState<DangerLevel>(campaign.dangerLevel);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline editor status line mirrors the Settings card: a transient "Saved."
  // confirmation after a successful write, cleared by a short timer.
  const dirty = isCampaignMetadataDirty(campaign, { name, description, dangerLevel });
  // Issue #760: block Switch campaign while the inline dashboard editor is dirty.
  useUnsavedWork(`dashboard-metadata:${campaignId}`, editing && dirty);

  function startEdit() {
    setName(campaign.name);
    setDescription(campaign.description);
    setDangerLevel(campaign.dangerLevel);
    setError(null);
    setSaved(false);
    setEditing(true);
  }

  function cancel() {
    // Reset to baseline so reopening never shows stale edits (issue #750).
    setName(campaign.name);
    setDescription(campaign.description);
    setDangerLevel(campaign.dangerLevel);
    setError(null);
    setSaved(false);
    setEditing(false);
  }

  async function save() {
    if (!name.trim()) {
      setError('Campaign name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch(`${API}/campaigns/${campaignId}`, { name: name.trim(), description, dangerLevel });
      setSaved(true);
      setEditing(false);
      onChange();
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      // Preserve the in-flight values on failure so a transient 5xx doesn't
      // silently discard what the DM typed (issue #750 acceptance criterion).
      setError(err instanceof ApiError ? err.message : "Couldn't save changes.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <section className="card elev-sm" style={{ padding: 16 }} aria-label="Edit campaign details">
        <CampaignMetadataFields
          idPrefix="dashboard-campaign"
          name={name}
          description={description}
          dangerLevel={dangerLevel}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onDangerLevelChange={setDangerLevel}
          error={error}
          disabled={saving}
        />
        <div className="flex gap-2 justify-end items-center">
          {saved && <span className="text-muted" style={{ fontSize: 12 }}>Saved.</span>}
          <Btn ghost onClick={cancel} disabled={saving}>
            Cancel
          </Btn>
          <Btn onClick={save} disabled={saving || !name.trim() || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </Btn>
        </div>
      </section>
    );
  }

  // Design: header row is just the campaign name + a wrapped chip row
  // (session, danger, location) — no boxed card. See Campfire.dc.html ~L417-425.
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px' }}>
      <h3 style={{ margin: 0 }}>{campaign.name}</h3>
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
            <Link
              to={`/c/${campaignId}/screen`}
              className="btn btn-ghost"
              style={{ fontSize: 12, textDecoration: 'none' }}
              title="Open the player display — a secret-free view to cast to a TV"
            >
              <GameIcon slug="tv" size={14} className="inline align-text-bottom mr-1" />Cast
            </Link>
            <Btn ghost style={{ fontSize: 12 }} title="DM only" onClick={startEdit}>
              ✎ Edit
            </Btn>
          </>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-rose-400" style={{ width: '100%', margin: 0 }}>{error}</p>}
      {saved && (
        <p role="status" className="text-xs" style={{ width: '100%', margin: 0, color: 'var(--color-success, #34d399)' }}>
          Saved.
        </p>
      )}
    </div>
  );
}
