import { useState } from 'react';
import type { Character } from '@campfire/schema';
import { API, api, ApiError } from '../../lib/api';
import { Btn, Card, ErrorNote } from '../../components/ui';

type Preview = { previewToken: string; runningCombatantCharacterIds: number[]; failures: Array<{ characterName: string; detail: string }>; characters: Array<{ characterId: number; name: string; hp: { before: number; after: number; tempBefore: number; tempAfter: number }; deathState: { before: string; after: string }; hitDiceSpent: number; hitDiceRolls: number[]; conditionsCleared: string[]; conditionsKept: string[]; resources: Record<string, { before: number; after: number }>; spellSlots: Record<string, { before: number; after: number }> }> };

/** Focused, native-control party recovery flow. The server remains authoritative for deltas. */
export function PartyRestPanel({ campaignId, characters, onClose, onApplied }: { campaignId: number; characters: Character[]; onClose: () => void; onApplied: () => void }) {
  const [kind, setKind] = useState<'short' | 'long' | 'custom'>('long');
  const [selected, setSelected] = useState(() => new Set(characters.filter((c) => c.status === 'active' && c.deathState !== 'dead').map((c) => c.id)));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [customKeys, setCustomKeys] = useState<string[]>([]);
  const [shortOptions, setShortOptions] = useState<Record<number, { spendHitDice?: number; hitDie?: number }>>({});
  const [combatAck, setCombatAck] = useState(false);
  const [applied, setApplied] = useState<{ batchId: number; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = [...selected];
  async function makePreview() {
    setBusy(true); setError(null);
    try { setPreview(await api.post<Preview>(`${API}/campaigns/${campaignId}/characters/rest/preview`, kind === 'short' ? { kind, characterIds: ids, perCharacter: Object.fromEntries(Object.entries(shortOptions).filter(([id]) => selected.has(Number(id)))) } : kind === 'custom' ? { kind, characterIds: ids, customResourceKeys: customKeys } : { kind, characterIds: ids })); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not preview recovery.'); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setError(null);
    try { const result = await api.post<{ batchId: number }>(`${API}/campaigns/${campaignId}/characters/rest/apply`, { previewToken: preview.previewToken, idempotencyKey: `party-rest-${preview.previewToken}`, acknowledgeRunningCombatants: combatAck }); setApplied({ batchId: result.batchId, key: `undo-${preview.previewToken}` }); onApplied(); }
    catch (err) { if (err instanceof ApiError && err.status === 409) { setPreview(null); setCombatAck(false); } setError(err instanceof ApiError ? err.message : 'Could not apply recovery.'); }
    finally { setBusy(false); }
  }
  return <Card className="space-y-3" aria-labelledby="party-rest-title">
    <div className="flex justify-between gap-2"><h2 id="party-rest-title" className="font-semibold">Rest party</h2><Btn type="button" onClick={onClose}>Close</Btn></div>
    {error && <ErrorNote message={error} />}
    <fieldset><legend className="text-sm font-medium">Recovery</legend>{(['short', 'long', 'custom'] as const).map((value) => <label key={value} className="mr-3"><input type="radio" name="party-rest-kind" checked={kind === value} onChange={() => { setKind(value); setPreview(null); setCombatAck(false); }} /> {value === 'custom' ? 'Custom reset' : `${value[0].toUpperCase()}${value.slice(1)} rest`}</label>)}</fieldset>
    {kind === 'custom' && <fieldset><legend className="text-sm font-medium">Resources to restore</legend>{[...new Set(characters.flatMap((c) => Object.keys(c.resources)))].map((key) => <label key={key} className="mr-3"><input type="checkbox" checked={customKeys.includes(key)} onChange={() => { setCustomKeys((old) => old.includes(key) ? old.filter((v) => v !== key) : [...old, key]); setPreview(null); setCombatAck(false); }} /> {key}</label>)}</fieldset>}
    {kind === 'short' && <fieldset><legend className="text-sm font-medium">Hit dice</legend>{characters.filter((c) => selected.has(c.id)).map((c) => <div key={c.id}><label>{c.name} dice <input aria-label={`${c.name} hit dice`} type="number" min="0" value={shortOptions[c.id]?.spendHitDice ?? 0} onChange={(e) => { setShortOptions((old) => ({ ...old, [c.id]: { ...old[c.id], spendHitDice: Number(e.target.value) } })); setPreview(null); setCombatAck(false); }} /></label><label> die size <input aria-label={`${c.name} hit die size`} type="number" min="2" value={shortOptions[c.id]?.hitDie ?? ''} onChange={(e) => { setShortOptions((old) => ({ ...old, [c.id]: { ...old[c.id], hitDie: e.target.value ? Number(e.target.value) : undefined } })); setPreview(null); setCombatAck(false); }} /></label></div>)}</fieldset>}
    <fieldset><legend className="text-sm font-medium">Participants</legend><label className="block"><input type="checkbox" checked={selected.size === characters.filter((c) => c.deathState !== 'dead').length} onChange={(e) => { setSelected(e.target.checked ? new Set(characters.filter((c) => c.deathState !== 'dead').map((c) => c.id)) : new Set()); setPreview(null); setCombatAck(false); }} /> Select eligible</label>{characters.map((c) => <label key={c.id} className="block"><input type="checkbox" disabled={c.deathState === 'dead'} checked={selected.has(c.id)} onChange={() => { setSelected((old) => { const next = new Set(old); if (next.has(c.id)) next.delete(c.id); else next.add(c.id); return next; }); setPreview(null); setCombatAck(false); }} /> {c.name}{c.deathState === 'dead' ? ' (dead — unavailable)' : c.status !== 'active' ? ` (${c.status})` : ''}</label>)}</fieldset>
    {!applied && (!preview ? <Btn type="button" disabled={busy || ids.length === 0 || (kind === 'custom' && customKeys.length === 0)} onClick={() => void makePreview()}>Preview recovery</Btn> : <><div aria-live="polite">{preview.failures.map((f) => <p key={f.characterName}>{f.detail}</p>)}{preview.characters.map((p) => <div key={p.characterId}><strong>{p.name}</strong>: HP {p.hp.before} → {p.hp.after} (temp {p.hp.tempBefore} → {p.hp.tempAfter}); death {p.deathState.before} → {p.deathState.after}; conditions cleared {p.conditionsCleared.join(', ') || 'none'}; kept {p.conditionsKept.join(', ') || 'none'}; hit dice {p.hitDiceSpent} [{p.hitDiceRolls.join(', ')}]; slots {Object.entries(p.spellSlots).map(([k, v]) => `${k}: ${v.before}→${v.after}`).join(', ') || 'unchanged'}; resources {Object.entries(p.resources).map(([k, v]) => `${k}: ${v.before}→${v.after}`).join(', ') || 'unchanged'}.</div>)}</div>{preview.runningCombatantCharacterIds.length > 0 && <label className="block"><input type="checkbox" checked={combatAck} onChange={(e) => setCombatAck(e.target.checked)} /> I acknowledge running combatants will be synchronized.</label>}<Btn type="button" disabled={busy || preview.failures.length > 0 || (preview.runningCombatantCharacterIds.length > 0 && !combatAck)} onClick={() => void apply()}>Apply recovery</Btn></>)}
    {applied && <Btn type="button" disabled={busy} onClick={() => { setBusy(true); void api.post(`${API}/campaigns/${campaignId}/characters/rest/${applied.batchId}/undo`, { idempotencyKey: applied.key }).then(() => { setApplied(null); setPreview(null); setCombatAck(false); onApplied(); }).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not undo recovery.')).finally(() => setBusy(false)); }}>Undo recovery</Btn>}
  </Card>;
}
