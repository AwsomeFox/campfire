import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CampaignSummary, Role, Campaign } from '@campfire/schema';

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
const DANGER_COLOR: Record<DangerLevel, string> = {
  low: 'text-emerald-400',
  moderate: 'text-rose-500',
  high: 'text-rose-500',
  deadly: 'text-rose-500',
};

export function StatusHeader({
  campaignId,
  summary,
  role,
  onChange,
}: {
  campaignId: number;
  summary: CampaignSummary;
  role: Role | null;
  onChange: () => void;
}) {
  const isDm = role === 'dm';
  const { campaign, currentLocation } = summary;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [description, setDescription] = useState(campaign.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cycleDanger() {
    if (!isDm) return;
    const idx = DANGER_CYCLE.indexOf(campaign.dangerLevel);
    const next = DANGER_CYCLE[(idx + 1) % DANGER_CYCLE.length];
    try {
      await api.patch(`${API}/campaigns/${campaignId}`, { dangerLevel: next });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update danger level.");
    }
  }

  function startEdit() {
    setName(campaign.name);
    setDescription(campaign.description);
    setEditing(true);
  }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${API}/campaigns/${campaignId}`, { name: name.trim(), description });
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
      <section className="cf-card p-5 md:p-6 space-y-3">
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" />
        <TextArea
          style={{ minHeight: 90 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
        />
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

  return (
    <section className="cf-card p-5 md:p-6 flex flex-col md:flex-row md:items-center gap-4">
      <div className="space-y-1 flex-1 min-w-0">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
          {campaign.status === 'active' ? 'Active campaign' : campaign.status}
        </p>
        <h1 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">{campaign.name}</h1>
        <p className="text-sm text-slate-400">
          Current location:{' '}
          {currentLocation ? (
            <Link to={`/c/${campaignId}/locations/${currentLocation.id}`} className="text-emerald-400 font-semibold hover:underline">
              {currentLocation.name}
            </Link>
          ) : (
            <span className="text-slate-500">Unset</span>
          )}
        </p>
        {error && <p className="text-xs text-rose-400">{error}</p>}
      </div>
      <div className="flex gap-3">
        <div className="cf-inset px-4 py-2 text-center">
          <p className="text-[10px] text-slate-500 font-bold uppercase">Session</p>
          <p className="text-lg font-bold text-white">{campaign.sessionCount}</p>
        </div>
        <button
          type="button"
          onClick={cycleDanger}
          disabled={!isDm}
          className="cf-inset px-4 py-2 text-center disabled:cursor-default"
          title={isDm ? 'Click to cycle danger level' : undefined}
        >
          <p className="text-[10px] text-slate-500 font-bold uppercase">Danger</p>
          <p className={`text-lg font-bold ${DANGER_COLOR[campaign.dangerLevel]}`}>
            ⚠️ {DANGER_LABEL[campaign.dangerLevel]}
          </p>
        </button>
        {isDm && (
          <Btn ghost className="hidden md:inline-flex" title="DM only" onClick={startEdit}>
            ✎ Edit
          </Btn>
        )}
      </div>
    </section>
  );
}
