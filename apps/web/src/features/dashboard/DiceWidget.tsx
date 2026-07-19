/**
 * Compact dice widget for the dashboard — the encounter dice log
 * (RunSessionPage's DiceLog) is the only place players ever saw a roller,
 * so out-of-combat rolls (checks, saves, loot) were invisible. Same
 * POST /campaigns/:id/roll endpoint, trimmed down to fit a dashboard card.
 */
import { useState, type FormEvent } from 'react';
import type { RollResult } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, TextInput, Btn } from '../../components/ui';

export function DiceWidget({ campaignId }: { campaignId: number }) {
  const [expr, setExpr] = useState('1d20');
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rolls, setRolls] = useState<RollResult[]>([]);

  async function roll(e: FormEvent) {
    e.preventDefault();
    if (!expr.trim()) return;
    setRolling(true);
    setError(null);
    try {
      const result = await api.post<RollResult>(`${API}/campaigns/${campaignId}/roll`, { expr: expr.trim() });
      setRolls((prev) => [result, ...prev].slice(0, 4));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't roll.");
    } finally {
      setRolling(false);
    }
  }

  return (
    <Card className="space-y-2.5">
      <span className="card-kicker">Dice</span>
      <form onSubmit={roll} className="flex gap-2 items-end flex-wrap">
        <div className="field" style={{ flex: 1, minWidth: 100 }}>
          <label>Expression</label>
          <TextInput placeholder="1d20+3" value={expr} onChange={(e) => setExpr(e.target.value)} />
        </div>
        <Btn type="submit" className="!min-h-0 !py-2 text-xs" disabled={rolling || !expr.trim()}>
          {rolling ? 'Rolling…' : 'Roll'}
        </Btn>
      </form>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      {rolls.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }}>
          Roll anytime — not just in combat. Try 1d20, 2d6+4, or 4d6.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {rolls.map((r, i) => (
            <div key={`${r.expr}-${i}-${r.total}`} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>{r.expr}</span>
              <span className="text-muted" style={{ fontSize: 11 }}>
                [{r.rolls.join(', ')}]
              </span>
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 16, color: 'var(--color-accent)', flex: 'none' }}>
                {r.total}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
