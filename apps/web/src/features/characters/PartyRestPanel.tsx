import { useState } from 'react';
import type { Character } from '@campfire/schema';
import { API, api, ApiError } from '../../lib/api';
import { Btn, Card, ErrorNote } from '../../components/ui';

type Preview = { previewToken: string; failures: Array<{ characterName: string; detail: string }>; characters: Array<{ characterId: number; name: string; hp: { before: number; after: number }; conditionsCleared: string[]; conditionsKept: string[]; resources: Record<string, unknown>; spellSlots: Record<string, unknown> }> };

/** Focused, native-control party recovery flow. The server remains authoritative for deltas. */
export function PartyRestPanel({ campaignId, characters, onClose, onApplied }: { campaignId: number; characters: Character[]; onClose: () => void; onApplied: () => void }) {
  const [kind, setKind] = useState<'short' | 'long' | 'custom'>('long');
  const [selected, setSelected] = useState(() => new Set(characters.filter((c) => c.status === 'active' && c.deathState !== 'dead').map((c) => c.id)));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = [...selected];
  async function makePreview() {
    setBusy(true); setError(null);
    try { setPreview(await api.post<Preview>(`${API}/campaigns/${campaignId}/characters/rest/preview`, kind === 'short' ? { kind, characterIds: ids, perCharacter: {} } : kind === 'custom' ? { kind, characterIds: ids, customResourceKeys: [] } : { kind, characterIds: ids })); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not preview recovery.'); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setError(null);
    try { await api.post(`${API}/campaigns/${campaignId}/characters/rest/apply`, { previewToken: preview.previewToken, idempotencyKey: `party-rest-${preview.previewToken}`, acknowledgeRunningCombatants: true }); onApplied(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not apply recovery.'); }
    finally { setBusy(false); }
  }
  return <Card className="space-y-3" aria-labelledby="party-rest-title">
    <div className="flex justify-between gap-2"><h2 id="party-rest-title" className="font-semibold">Rest party</h2><Btn type="button" onClick={onClose}>Close</Btn></div>
    {error && <ErrorNote message={error} />}
    <fieldset><legend className="text-sm font-medium">Recovery</legend>{(['short', 'long', 'custom'] as const).map((value) => <label key={value} className="mr-3"><input type="radio" name="party-rest-kind" checked={kind === value} onChange={() => { setKind(value); setPreview(null); }} /> {value === 'custom' ? 'Custom reset' : `${value[0].toUpperCase()}${value.slice(1)} rest`}</label>)}</fieldset>
    <fieldset><legend className="text-sm font-medium">Participants</legend><label className="block"><input type="checkbox" checked={selected.size === characters.filter((c) => c.deathState !== 'dead').length} onChange={(e) => setSelected(e.target.checked ? new Set(characters.filter((c) => c.deathState !== 'dead').map((c) => c.id)) : new Set())} /> Select eligible</label>{characters.map((c) => <label key={c.id} className="block"><input type="checkbox" disabled={c.deathState === 'dead'} checked={selected.has(c.id)} onChange={() => setSelected((old) => { const next = new Set(old); next.has(c.id) ? next.delete(c.id) : next.add(c.id); return next; })} /> {c.name}{c.deathState === 'dead' ? ' (dead — unavailable)' : c.status !== 'active' ? ` (${c.status})` : ''}</label>)}</fieldset>
    {!preview ? <Btn type="button" disabled={busy || ids.length === 0} onClick={() => void makePreview()}>Preview recovery</Btn> : <><div aria-live="polite">{preview.failures.map((f) => <p key={f.characterName}>{f.detail}</p>)}{preview.characters.map((p) => <div key={p.characterId}><strong>{p.name}</strong>: HP {p.hp.before} → {p.hp.after}; slots {Object.keys(p.spellSlots).join(', ') || 'unchanged'}; resources {Object.keys(p.resources).join(', ') || 'unchanged'}; cleared {p.conditionsCleared.join(', ') || 'none'}; kept {p.conditionsKept.join(', ') || 'none'}.</div>)}</div><Btn type="button" disabled={busy || preview.failures.length > 0} onClick={() => void apply()}>Apply recovery</Btn></>}
  </Card>;
}
