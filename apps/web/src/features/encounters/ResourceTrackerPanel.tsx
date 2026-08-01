import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character, Combatant, CharacterResource, SpellSlotLevel } from '@campfire/schema';
import { Card, Btn } from '../../components/ui';
import { api, API } from '../../lib/api';

function Pips({ max, used, onChange }: { max: number; used: number; onChange: (used: number) => void }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {Array.from({ length: max }).map((_, i) => (
        <button
          key={i}
          className="w-4 h-4 rounded-full border border-current flex items-center justify-center cursor-pointer opacity-80 hover:opacity-100"
          onClick={() => onChange(i < used ? i : i + 1)}
          title={`Set used to ${i < used ? i : i + 1}`}
          type="button"
        >
          {i < used ? '●' : '○'}
        </button>
      ))}
    </div>
  );
}

export function ResourceTrackerPanel({
  campaignId,
  encounterId,
  characters,
  combatants,
  canDmWrite
}: {
  campaignId: number;
  encounterId: number;
  characters: Character[];
  combatants: Combatant[];
  canDmWrite: boolean;
}) {
  useTranslation();
  const [busy, setBusy] = useState(false);

  const applyRest = async (kind: 'short' | 'long' | 'custom', customKeys?: string[]) => {
    if (!canDmWrite) return;
    setBusy(true);
    try {
      // Placeholder
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Resource Tracker</h3>
        {canDmWrite && (
          <div className="flex gap-2">
            <Btn density="compact" disabled={busy} onClick={() => applyRest('short')}>Short Rest</Btn>
            <Btn density="compact" disabled={busy} onClick={() => applyRest('long')}>Long Rest</Btn>
            <Btn density="compact" disabled={busy} onClick={() => applyRest('custom', [])}>Reset All</Btn>
          </div>
        )}
      </div>
      
      <div className="space-y-4 max-h-96 overflow-y-auto">
        {combatants.map(c => {
          let resources: Record<string, CharacterResource> = {};
          let spellSlots: Record<string, SpellSlotLevel> = {};
          
          if (c.kind === 'character' && c.characterId) {
            const char = characters.find(ch => ch.id === c.characterId);
            if (char) {
              resources = char.resources;
              spellSlots = char.spellSlots;
            }
          } else if (c.statblock) {
            // @ts-ignore
            resources = c.statblock.resources || {};
            // @ts-ignore
            spellSlots = c.statblock.spellSlots || {};
          }

          const hasResources = Object.keys(resources).length > 0;
          const hasSpellSlots = Object.keys(spellSlots).length > 0;
          
          if (!hasResources && !hasSpellSlots) return null;

          return (
            <div key={c.id} className="border-t pt-2 mt-2 first:mt-0 first:border-0 first:pt-0">
              <div className="font-medium mb-2">{c.name}</div>
              
              {hasResources && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase text-muted">Features</div>
                  {Object.entries(resources).map(([key, res]) => (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <div className="text-sm">
                        {res.name || key} 
                        {res.recharge && <span className="ml-2 text-xs opacity-70">({res.recharge})</span>}
                        {/* @ts-ignore */}
                        {res.source && <span className="ml-2 text-xs opacity-70">[{res.source}]</span>}
                      </div>
                      <Pips 
                        max={res.max} 
                        used={res.used} 
                        onChange={(val) => {
                          if (!canDmWrite && (!c.characterId || c.characterId === 0)) return;
                          if (c.kind === 'character' && c.characterId) {
                            api.post(`${API}/characters/${c.characterId}/resources`, {
                              // @ts-ignore
                              [key]: { used: val, max: res.max, name: res.name, recharge: res.recharge, source: res.source }
                            });
                          } else if (c.statblock) {
                            api.patch(`${API}/encounters/${encounterId}/combatants/${c.id}`, {
                              // @ts-ignore
                              statblock: { ...c.statblock, resources: { ...c.statblock.resources, [key]: { ...res, used: val } } }
                            });
                          }
                        }} 
                      />
                    </div>
                  ))}
                </div>
              )}

              {hasSpellSlots && (
                <div className="space-y-2 mt-3">
                  <div className="text-xs font-semibold uppercase text-muted">Spell Slots</div>
                  {Object.entries(spellSlots).map(([level, slot]) => (
                    <div key={level} className="flex items-center justify-between gap-4">
                      <div className="text-sm">Level {level}</div>
                      <Pips 
                        max={slot.max} 
                        used={slot.used} 
                        onChange={(val) => {
                          if (!canDmWrite && (!c.characterId || c.characterId === 0)) return;
                          if (c.kind === 'character' && c.characterId) {
                            api.post(`${API}/characters/${c.characterId}/spell-slots`, {
                              [level]: { used: val, max: slot.max }
                            });
                          } else if (c.statblock) {
                            api.patch(`${API}/encounters/${encounterId}/combatants/${c.id}`, {
                              // @ts-ignore
                              statblock: { ...c.statblock, spellSlots: { ...c.statblock.spellSlots, [level]: { ...slot, used: val } } }
                            });
                          }
                        }} 
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
