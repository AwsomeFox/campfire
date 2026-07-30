import React, { useRef, useState, useMemo, useCallback, useLayoutEffect } from 'react';
import type { EncounterEvent } from '@campfire/schema';
import { Card } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import {
  groupCombatLogEvents,
  formatCombatLogChainDetails,
  formatCombatLogChainSummary,
  formatCombatLogEventSummary,
} from './combatLogAccessibility'; 

const EVENT_ICON: Record<string, string> = {
  damage: 'crossed-swords',
  heal: 'sparkles',
  condition: 'whirlwind',
  death: 'death-skull',
  turn: 'stopwatch',
  roll: 'rolling-dices',
  note: 'quill-ink',
  override: 'tabletop-players',
  correction: 'quill-ink',
};

export const CombatLog = React.memo(function CombatLog({ events }: { events: EncounterEvent[] }) {
  const { t } = useTranslation('encounters');
  const headingId = 'combat-log-heading';
  const logRef = useRef<HTMLDivElement>(null);
  const preservedScrollTopRef = useRef(0);
  const [expandedChains, setExpandedChains] = useState<Set<string>>(() => new Set());
  const chains = useMemo(() => groupCombatLogEvents(events), [events]);

  const toggleChain = useCallback((key: string) => {
    setExpandedChains((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    log.scrollTop = preservedScrollTopRef.current;
    return () => {
      preservedScrollTopRef.current = log.scrollTop;
    };
  }, [events]);

  return (
    <Card className="space-y-2 min-w-0" id="combat-log">
      <h2 id={headingId} className="card-kicker" style={{ margin: 0 }}>{t('combatLogHeading', 'Combat log')}</h2>
      <div
        ref={logRef}
        role="log"
        aria-labelledby={headingId}
        aria-live="off"
        tabIndex={0}
        className="reading-supporting min-w-0"
        style={{ maxHeight: 260, overflowY: 'auto', overflowX: 'hidden', overflowAnchor: 'none', overflowWrap: 'anywhere' }}
      >
        {events.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
            Nothing yet — damage, healing, conditions, deaths, rolls, turns, notes, overrides and corrections will show here as the fight unfolds.
          </p>
        ) : (
          <ol style={{ display: 'flex', flexDirection: 'column', gap: 4, listStyle: 'none', margin: 0, padding: 0 }}>
            {chains.map((chain) => {
              const head = chain.events[0];
              const chainKey = chain.chainId ?? `solo-${head.id}`;
              const expandable = chain.events.length > 1;
              const expanded = expandedChains.has(chainKey);
              const details = expandable ? formatCombatLogChainDetails(chain) : [];
              const summary = chain.chainId ? formatCombatLogChainSummary(chain) : formatCombatLogEventSummary(head);
              const iconType = head.type;
              return (
                <li key={chainKey} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12.5, lineHeight: 1.4 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span aria-hidden="true" style={{ flex: 'none' }}>
                      {EVENT_ICON[iconType] ? <GameIcon slug={EVENT_ICON[iconType]} size={UI_ICON_SIZE.xs} /> : '•'}
                    </span>
                    {head.round > 0 && (
                      <span className="tag tag-neutral" style={{ fontSize: 9, flex: 'none' }}>
                        R{head.round}
                      </span>
                    )}
                    {expandable ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => toggleChain(chainKey)}
                        aria-expanded={expanded}
                        style={{ minWidth: 0, textAlign: 'left', fontSize: 'inherit', padding: 0 }}
                      >
                        {summary}
                      </button>
                    ) : (
                      <span style={{ minWidth: 0 }}>{summary}</span>
                    )}
                  </div>
                  {expandable && expanded && details.length > 0 && (
                    <ul style={{ margin: '0 0 0 28px', padding: 0, listStyle: 'disc', color: 'var(--color-text-secondary)' }}>
                      {details.map((line, detailIndex) => (
                        <li key={`${chainKey}-${detailIndex}`}>{line}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Card>
  );
});
