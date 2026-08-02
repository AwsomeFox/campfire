import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ActionSpec } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { invalidateEncounter } from '../../lib/query';
import { useAnnounce } from '../../components/Announcer';
import { useRollResultToast } from '../../components/RollResultToastContext';
import { advFromEvent } from '../../lib/characterStats';

export function getDamageTypeIcon(type: string): string {
  const t = type.toLowerCase().trim();
  if (t.includes('fire')) return '🔥';
  if (t.includes('cold') || t.includes('ice')) return '❄️';
  if (t.includes('lightning') || t.includes('electric')) return '⚡';
  if (t.includes('thunder')) return '🔊';
  if (t.includes('acid') || t.includes('poison')) return '🧪';
  if (t.includes('radiant') || t.includes('holy')) return '✨';
  if (t.includes('necrotic') || t.includes('dark')) return '💀';
  if (t.includes('psychic') || t.includes('mind')) return '🧠';
  if (t.includes('force')) return '💥';
  return '⚔️';
}

export function parseToHitDisplay(toHit: string): string {
  const trimmed = toHit.trim();
  if (!trimmed) return '';
  if (/^[+-]?\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    return num >= 0 ? `+${num}` : `${num}`;
  }
  const match = /^([+-]?\d+)/.exec(trimmed);
  if (match) {
    const num = parseInt(match[1], 10);
    return num >= 0 ? `+${num}` : `${num}`;
  }
  return trimmed;
}

export function parseDamageDisplay(damage: string): { display: string; icon: string; type: string } {
  const trimmed = damage.trim();
  if (!trimmed) return { display: '', icon: '⚔️', type: '' };

  const match = /^(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*(.*)$/i.exec(trimmed);
  if (match) {
    const expr = match[1].replace(/\s+/g, '');
    const type = match[2].trim();
    const icon = getDamageTypeIcon(type);
    return { display: `${expr} ${icon}`, icon, type };
  }

  const flatMatch = /^(\d+)\s*(.*)$/i.exec(trimmed);
  if (flatMatch) {
    const val = flatMatch[1];
    const type = flatMatch[2].trim();
    const icon = getDamageTypeIcon(type);
    return { display: `${val} ${icon}`, icon, type };
  }

  return { display: `${trimmed} ⚔️`, icon: '⚔️', type: '' };
}

export interface QuickRollButtonsProps {
  encounterId: number;
  combatantId?: number;
  actorName?: string;
  actionName: string;
  toHit?: string;
  damage?: string;
  spec?: ActionSpec | null;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
}

export function QuickRollButtons({
  encounterId,
  combatantId,
  actorName,
  actionName,
  toHit,
  damage,
  spec,
  disabled = false,
  disabledReason,
  className = '',
}: QuickRollButtonsProps) {
  useTranslation();
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const { showRoll } = useRollResultToast();
  const [lastOutcome, setLastOutcome] = useState<{
    kind: 'to-hit' | 'damage';
    total: number;
    isNat20?: boolean;
    isNat1?: boolean;
    icon?: string;
  } | null>(null);

  // Derive toHit string if omitted but spec.attack exists
  let effectiveToHit = toHit ?? '';
  if (!effectiveToHit && spec?.attack?.bonus) {
    effectiveToHit = spec.attack.bonus;
  }

  // Derive damage string if omitted but spec.outcomes exists
  let effectiveDamage = damage ?? '';
  if (!effectiveDamage && spec?.outcomes) {
    const outcomes = spec.outcomes as Record<string, any>;
    const branch = outcomes.hit || outcomes.normal || outcomes.success || outcomes.crit;
    if (branch?.damage && Array.isArray(branch.damage) && branch.damage.length > 0) {
      const parts = branch.damage.map((d: any) => {
        const formula = d.formula ? d.formula : '';
        const flat = d.flat && d.flat !== 0 ? (d.flat > 0 ? `+${d.flat}` : `${d.flat}`) : '';
        const type = d.type ? ` ${d.type}` : '';
        return `${formula}${flat}${type}`;
      });
      effectiveDamage = parts.join(' + ');
    }
  }

  const toHitDisplay = parseToHitDisplay(effectiveToHit);
  const damageInfo = parseDamageDisplay(effectiveDamage);

  const quickRoll = useMutation({
    mutationFn: (vars: { kind: 'to-hit' | 'damage'; expr: string; mode?: 'flat' | 'advantage' | 'disadvantage' }) =>
      api.post<{
        roll: any;
        event: any;
        breakdown: string;
        isNat20: boolean;
        isNat1: boolean;
        total: number;
      }>(`${API}/encounters/${encounterId}/quick-roll`, {
        combatantId,
        actorName,
        actionName,
        kind: vars.kind,
        expr: vars.expr,
        mode: vars.mode || 'flat',
      }),
    onSuccess: (data, vars) => {
      invalidateEncounter(queryClient, encounterId);
      if (data.roll) {
        showRoll(data.roll);
      }
      setLastOutcome({
        kind: vars.kind,
        total: data.total,
        isNat20: data.isNat20,
        isNat1: data.isNat1,
        icon: vars.kind === 'damage' ? damageInfo.icon : undefined,
      });

      if (vars.kind === 'to-hit') {
        const natText = data.isNat20 ? ' — CRITICAL HIT! (Nat 20)' : data.isNat1 ? ' — CRITICAL MISS! (Nat 1)' : '';
        announce(`${actionName} to-hit: ${data.total}${natText}`);
      } else {
        announce(`${actionName} damage: ${data.total}`);
      }
    },
  });

  if (!toHitDisplay && !damageInfo.display) return null;

  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`} data-testid="quick-roll-buttons">
      {toHitDisplay && (
        <button
          type="button"
          className="btn btn-ghost cf-target-44 text-xs font-semibold px-2 py-1 inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md border border-amber-500/40 bg-amber-950/20 text-amber-300 hover:bg-amber-900/40 focus:outline-none focus:ring-2 focus:ring-amber-400"
          disabled={disabled || quickRoll.isPending}
          title={disabledReason || `Quick roll ${actionName} to-hit (${toHitDisplay}) · Shift-click for advantage · Alt/Ctrl-click for disadvantage`}
          aria-label={`Quick roll ${actionName} to-hit (${toHitDisplay})`}
          data-testid="quick-roll-to-hit"
          onClick={(e) => {
            e.stopPropagation();
            const adv = advFromEvent(e);
            const mode = adv === 'adv' ? 'advantage' : adv === 'dis' ? 'disadvantage' : 'flat';
            quickRoll.mutate({ kind: 'to-hit', expr: effectiveToHit, mode });
          }}
        >
          [{toHitDisplay}]
        </button>
      )}
      {damageInfo.display && (
        <button
          type="button"
          className="btn btn-ghost cf-target-44 text-xs font-semibold px-2 py-1 inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md border border-rose-500/40 bg-rose-950/20 text-rose-300 hover:bg-rose-900/40 focus:outline-none focus:ring-2 focus:ring-rose-400"
          disabled={disabled || quickRoll.isPending}
          title={disabledReason || `Quick roll ${actionName} damage (${damageInfo.display})`}
          aria-label={`Quick roll ${actionName} damage (${damageInfo.display})`}
          data-testid="quick-roll-damage"
          onClick={(e) => {
            e.stopPropagation();
            quickRoll.mutate({ kind: 'damage', expr: effectiveDamage, mode: 'flat' });
          }}
        >
          [{damageInfo.display}]
        </button>
      )}
      {lastOutcome?.kind === 'to-hit' && lastOutcome.isNat20 && (
        <span
          className="tag font-bold text-xs bg-amber-400 text-black px-1.5 py-0.5 rounded shadow animate-pulse"
          data-testid="quick-roll-nat20-badge"
        >
          💥 NAT 20!
        </span>
      )}
      {lastOutcome?.kind === 'to-hit' && lastOutcome.isNat1 && (
        <span
          className="tag font-bold text-xs bg-red-600 text-white px-1.5 py-0.5 rounded"
          data-testid="quick-roll-nat1-badge"
        >
          💀 NAT 1
        </span>
      )}
    </div>
  );
}
