import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RuleEntry } from '@campfire/schema';
import { api, API } from '../../../lib/api';
import { Skeleton } from '../../../components/ui';
import { StatBlock, hasMonsterStatblock } from '../../../components/StatBlock';
import { useDisclosure } from '../../../components/useDisclosure';

/**
 * Collapsible statblock for a compendium-linked monster combatant (issue #56). The
 * combatant only stores a `ruleEntryId`; the entry's AC / attacks / ability scores live
 * in its `dataJson`, fetched lazily from the existing rules read path on first expand
 * and rendered with the shared StatBlock component (added by #142). Kept collapsed by
 * default so the initiative row stays scannable mid-fight.
 */
export type CombatantStatblockProps = {
  ruleEntryId: number;
  ruleSystem: string | null;
  campaignId?: number;
};

export function CombatantStatblock({ ruleEntryId, ruleSystem, campaignId }: CombatantStatblockProps) {
  useTranslation();
  const { open, setOpen, buttonProps, regionProps } = useDisclosure({
    focusManagement: false,
    // No regionLabel: StatBlock inside already exposes a labelled "Creature
    // statblock" region (see StatBlock.tsx). The wrapper stays a plain div so
    // we don't nest redundant landmarks.
  });
  const [entry, setEntry] = useState<RuleEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && entry === null && !loading) {
      setLoading(true);
      setFailed(false);
      try {
        const url = `${API}/rules/entries/${ruleEntryId}${campaignId ? `?campaignId=${campaignId}` : ''}`;
        const e = await api.get<RuleEntry>(url);
        setEntry(e);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div style={{ marginTop: 5 }}>
      <button
        type="button"
        className="btn btn-ghost"
        {...buttonProps}
        onClick={toggle}
        style={{ fontSize: 'var(--type-label)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Statblock
      </button>
      {open && (
        <div
          {...regionProps}
          style={{
            marginTop: 6,
            padding: '10px 12px',
            border: '1px solid var(--color-divider)',
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in srgb, var(--color-accent) 4%, transparent)',
            maxWidth: 460,
          }}
        >
          {loading ? (
            <Skeleton lines={3} />
          ) : failed ? (
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              Couldn&apos;t load the statblock.
            </p>
          ) : entry && hasMonsterStatblock(entry.dataJson, ruleSystem) ? (
            <StatBlock data={entry.dataJson} ruleSystem={ruleSystem} />
          ) : (
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              No statblock details for this entry.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
