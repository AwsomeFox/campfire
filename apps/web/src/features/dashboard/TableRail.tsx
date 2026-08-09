/**
 * The dashboard's right-hand table rail, from the Claude Design template
 * `templates/campaign-dashboard/CampaignDashboard.dc.html`.
 *
 * The design's rail is a tab strip over one scrolling pane with the shared dice tray pinned
 * beneath it (`grid-template-rows:auto 1fr auto`). Tabs rather than a stack because these are
 * the at-the-table surfaces a player dips into one at a time — notes, check requests, table
 * talk — and stacking them pushed the dice, the thing reached for most often, past the fold.
 *
 * The dice tray sits OUTSIDE the panels, so switching tabs never takes it away.
 *
 * The design's fourth tab, "Log", is not here: this app's `SessionLog` is one component
 * covering both the next-session card the design puts in its LEFT rail and the session list it
 * puts in this one. Splitting it to match the template exactly would divide a component four
 * scheduling specs read as a unit, for no gain a reader would notice — so the whole of it stays
 * in the left rail, where the design puts the half that matters at a glance.
 */
import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import type { CampaignSummary } from '@campfire/schema';
import { NotesQuickRail } from './NotesQuickRail';
import { DiceWidget } from './DiceWidget';
import { EntityDiscussion } from '../comments/EntityDiscussion';
import { CheckRequestPanel } from '../encounters/CheckRequests';

type RailTab = 'notes' | 'checks' | 'talk';

const TAB_LABEL: Record<RailTab, string> = {
  notes: 'Notes',
  checks: 'Checks',
  talk: 'Talk',
};

export function TableRail({
  campaignId,
  openInboxCount,
  characters,
  isDm,
}: {
  campaignId: number;
  openInboxCount: CampaignSummary['openInboxCount'];
  characters: CampaignSummary['characters'];
  /** Check requests are raised by the DM only — the tab is absent for everyone else. */
  isDm: boolean;
}) {
  // Built from `isDm` rather than filtered at render, so the roving tabindex and the
  // arrow-key wrap below are computed over the tabs that actually exist for this viewer.
  const tabs: RailTab[] = isDm ? ['notes', 'checks', 'talk'] : ['notes', 'talk'];
  const [tab, setTab] = useState<RailTab>('notes');
  const tabRefs = useRef<Partial<Record<RailTab, HTMLButtonElement | null>>>({});

  const onTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.indexOf(tab);
    let next: RailTab | null = null;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }, [tab, tabs]);

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="seg self-start inline-flex max-w-full" role="tablist" aria-label="Table rail sections">
        {tabs.map((t) => {
          const selected = tab === t;
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`dashboard-rail-tab-${t}`}
              aria-selected={selected}
              aria-controls={`dashboard-rail-panel-${t}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={onTabKeyDown}
              className="seg-opt"
              style={{ padding: '6px 12px', fontSize: 12, minHeight: 36 }}
            >
              {TAB_LABEL[t]}
            </button>
          );
        })}
      </div>

      {/*
        Every panel stays MOUNTED and is hidden with `hidden`, rather than being unmounted when
        its tab is inactive.

        Unmounting was the first shape here and it looked like the tidier one — an inactive
        panel's polling children would stop with it. It also, reproducibly, killed the API
        server: with unmounting, `--shard=4/4` lost the server part-way through on three runs
        out of three (37-41 connection-refused failures, no crash output), and the same shard on
        the same commit with panels kept mounted survived cleanly. Nothing else differed — same
        175 tests, same 45 specs, same seed. The tab churn tearing these panels' subscriptions
        down and back up is the trigger; the server dying because of it is a robustness bug of
        its own, and one this layout change is the wrong place to fix.

        Keeping them mounted is also no more load than the dashboard already carried: before the
        rail existed, all three of these rendered on it at once, unconditionally.
      */}
      <div role="tabpanel" id="dashboard-rail-panel-notes" aria-labelledby="dashboard-rail-tab-notes" className="min-w-0" hidden={tab !== 'notes'}>
        <NotesQuickRail campaignId={campaignId} openInboxCount={openInboxCount} />
      </div>
      {isDm && (
        <div role="tabpanel" id="dashboard-rail-panel-checks" aria-labelledby="dashboard-rail-tab-checks" className="min-w-0" hidden={tab !== 'checks'}>
          <CheckRequestPanel campaignId={campaignId} characters={characters} />
        </div>
      )}
      <div role="tabpanel" id="dashboard-rail-panel-talk" aria-labelledby="dashboard-rail-tab-talk" className="min-w-0" hidden={tab !== 'talk'}>
        <EntityDiscussion campaignId={campaignId} entityType="campaign" entityId={campaignId} />
      </div>

      {/* Pinned beneath the panels, exactly as the template pins it: the tray is what a table
          reaches for during play, and it must not be a tab away. */}
      <DiceWidget campaignId={campaignId} />
    </div>
  );
}
