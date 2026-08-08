import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RuleEntry, CustomMechanicsProfile } from '@campfire/schema';
import { api, API } from '../../../lib/api';
import { Skeleton } from '../../../components/ui';
import { StatBlock, entryRendersMonsterStatblock } from '../../../components/StatBlock';
import { EntryFacts, hasEntryFacts } from '../../../components/EntryFacts';
import { useDisclosure } from '../../../components/useDisclosure';

/**
 * Collapsible statblock for a compendium-linked monster combatant (issue #56). The
 * combatant only stores a `ruleEntryId`; the entry's AC / attacks / ability scores live
 * in its `dataJson`, fetched lazily from the existing rules read path on first expand
 * and rendered with the shared StatBlock component (added by #142). Kept collapsed by
 * default so the initiative row stays scannable mid-fight.
 */
export type Props = {
  ruleEntryId: number;
  ruleSystem: string | null;
  customMechanicsProfile?: CustomMechanicsProfile | null;
  campaignId?: number;
};

export const CombatantStatblock = memo(function CombatantStatblock({ ruleEntryId, ruleSystem, customMechanicsProfile, campaignId }: Props) {
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
          ) : entry && entryRendersMonsterStatblock(entry.type, entry.dataJson, ruleSystem, customMechanicsProfile) ? (
            <StatBlock data={entry.dataJson} ruleSystem={ruleSystem} customMechanicsProfile={customMechanicsProfile} />
          ) : entry && hasEntryFacts(entry.dataJson) ? (
            // A combatant need not be a creature — AddCombatantPanel searches for and accepts
            // `hazard` entries too. A hazard is better served here than by the creature
            // statblock it used to borrow: this shows its stealth DC, disable check, reset
            // and complexity, none of which a creature statblock has a slot for.
            <EntryFacts data={entry.dataJson} compact />
          ) : (
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
              No statblock details for this entry.
            </p>
          )}
        </div>
      )}
    </div>
  );
});
