import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CampaignSummary, Role, Campaign, Encounter } from '@campfire/schema';

type DangerLevel = Campaign['dangerLevel'];
import { api, API, ApiError } from '../../lib/api';
import { Btn, TextInput, TextArea } from '../../components/ui';

const DANGER_CYCLE: DangerLevel[] = ['low', 'moderate', 'high', 'deadly'];
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
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setName(campaign.name);
    setDescription(campaign.description);
    setDangerLevel(campaign.dangerLevel);
    setEditing(true);
  }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${API}/campaigns/${campaignId}`, { name: name.trim(), description, dangerLevel });
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save changes.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <section className="card elev-sm" style={{ padding: 16 }}>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" />
        <TextArea
          style={{ minHeight: 90 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
        />
        <div className="field" style={{ maxWidth: 200 }}>
          <label htmlFor="status-danger">Danger level</label>
          <select
            id="status-danger"
            className="input"
            value={dangerLevel}
            onChange={(e) => setDangerLevel(e.target.value as DangerLevel)}
          >
            {DANGER_CYCLE.map((level) => (
              <option key={level} value={level}>
                {DANGER_LABEL[level]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2 justify-end">
          <Btn ghost onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Btn>
          <Btn onClick={save} disabled={saving || !name.trim()}>
            Save
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
          Session {campaign.sessionCount}
        </span>
        <span className="tag tag-accent" style={{ whiteSpace: 'nowrap' }}>
          {DANGER_LABEL[campaign.dangerLevel]} danger
        </span>
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
          <Btn ghost style={{ fontSize: 12 }} title="DM only" onClick={startEdit}>
            ✎ Edit
          </Btn>
        )}
      </div>
      {error && <p className="text-xs text-rose-400" style={{ width: '100%', margin: 0 }}>{error}</p>}
    </div>
  );
}
