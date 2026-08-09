import type * as React from 'react';
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { CampaignLibraryMonster, Character, CombatantKind, CombatantStatblock as CombatantStatblockData, CustomMechanicsProfile, Npc, RuleEntry, RulePack } from '@campfire/schema';
import { COMBATANT_STATBLOCK_HELP, defaultCombatantStatblock } from '@campfire/schema';
import { api, API, translateApiError } from '../../../lib/api';
import { useAnnounce } from '../../../components/Announcer';
import { Btn, Card, Skeleton, TextInput } from '../../../components/ui';
import { CombatantStatblockEditor } from '../CombatantStatblockEditor';

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

type AddTab = 'manual' | 'compendium' | 'library' | 'party' | 'npc';
const ADD_TAB_ORDER: ReadonlyArray<AddTab> = ['manual', 'compendium', 'library', 'party', 'npc'];
const ADD_TAB_LABELS: Record<AddTab, string> = {
  manual: 'Manual',
  compendium: 'Compendium',
  library: 'Library',
  party: 'Party',
  npc: 'NPC',
};
const EMPTY_PACK_SLUGS: string[] = [];
const EMPTY_RULE_PACKS: RulePack[] = [];

export type Props = {
  encounterId: number;
  campaignId: number;
  characters: Character[];
  existingCombatantCharacterIds: Set<number>;
  rulePack: string;
  enabledPackSlugs?: string[];
  installedPacks?: RulePack[];
  customMechanicsProfile?: CustomMechanicsProfile | null;
  onAdded: () => Promise<void> | void;
};

export function AddCombatantPanel({
  encounterId,
  campaignId: cid,
  characters,
  existingCombatantCharacterIds,
  rulePack,
  enabledPackSlugs = EMPTY_PACK_SLUGS,
  installedPacks = EMPTY_RULE_PACKS,
  customMechanicsProfile,
  onAdded,
}: Props) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const [tab, setTab] = useState<AddTab>('manual');
  const tabRefs = useRef<Record<AddTab, HTMLButtonElement | null>>({
    manual: null,
    compendium: null,
    library: null,
    party: null,
    npc: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Manual
  const [name, setName] = useState('');
  const [hpMax, setHpMax] = useState('');
  const [initMod, setInitMod] = useState('');
  const [manualCount, setManualCount] = useState('1');
  const [manualStatblock, setManualStatblock] = useState<CombatantStatblockData>(() => defaultCombatantStatblock());

  // Campaign library (issue #425)
  const [library, setLibrary] = useState<CampaignLibraryMonster[]>([]);
  // Issue #2080 (regression fix): per-entry HP typed into a Library-tab card's own inline
  // input, keyed by library monster id. Only rendered for entries whose stored
  // statblock.hp is null — the only case where the server has no HP to seed from and the
  // DM must supply one to add at all.
  const [libraryHpDrafts, setLibraryHpDrafts] = useState<Record<number, string>>({});

  // Compendium
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 300);
  const [results, setResults] = useState<RuleEntry[]>([]);
  const [searching, setSearching] = useState(false);
  // Quantity + optional name override applied to the next compendium add (issue #114).
  const [compCount, setCompCount] = useState('1');
  const [nameOverride, setNameOverride] = useState('');

  // NPC (issue: NPCs as combatants) — pick a campaign NPC for identity, then give it
  // HP manually or by linking a compendium statblock (the compendium search below).
  const [npcs, setNpcs] = useState<Npc[]>([]);
  const [selectedNpcId, setSelectedNpcId] = useState('');
  const [npcHp, setNpcHp] = useState('');
  const [npcInit, setNpcInit] = useState('');

  /** Clamp a free-text quantity field to a sane 1–50, defaulting to 1. */
  function parseCount(raw: string): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(50, n);
  }

  function selectAddTab(next: AddTab) {
    setTab(next);
    announce(`${ADD_TAB_LABELS[next]} tab selected.`);
  }

  function focusAddTab(which: AddTab) {
    tabRefs.current[which]?.focus();
  }

  function onAddTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const idx = ADD_TAB_ORDER.indexOf(tab);
    if (idx < 0) return;
    let next: AddTab | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = ADD_TAB_ORDER[(idx + 1) % ADD_TAB_ORDER.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = ADD_TAB_ORDER[(idx - 1 + ADD_TAB_ORDER.length) % ADD_TAB_ORDER.length];
        break;
      case 'Home':
        next = ADD_TAB_ORDER[0];
        break;
      case 'End':
        next = ADD_TAB_ORDER[ADD_TAB_ORDER.length - 1];
        break;
      default:
        return;
    }
    if (next && next !== tab) {
      event.preventDefault();
      selectAddTab(next);
      requestAnimationFrame(() => focusAddTab(next));
    } else if (next) {
      event.preventDefault();
      focusAddTab(next);
    }
  }

  // Campaign NPCs for the NPC tab's picker. Low-churn, fetched once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<Npc[]>(`${API}/campaigns/${cid}/npcs`);
        if (!cancelled) setNpcs(list);
      } catch {
        /* leave empty — the tab shows an empty-state hint */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cid]);

  useEffect(() => {
    if (tab !== 'library') return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get<CampaignLibraryMonster[]>(`${API}/campaigns/${cid}/library/monsters`);
        if (!cancelled) setLibrary(list);
      } catch {
        if (!cancelled) setLibrary([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cid, tab]);

  useEffect(() => {
    if ((tab !== 'compendium' && tab !== 'npc') || !debouncedQuery.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setSearching(true);
      try {
        const baseParams = new URLSearchParams({ q: debouncedQuery.trim() });
        // Encounter statblocks may only come from the primary pack or a pack that
        // explicitly declares compatibility with it. Other enabled packs remain
        // reference-only in Compendium/AI lookups so foreign combat math is never
        // silently interpreted through this campaign's adapter.
        const compatiblePackSlugs = [...new Set([
          rulePack,
          ...enabledPackSlugs.filter((slug) =>
            installedPacks.some((pack) => pack.slug === slug && pack.extendsPackSlug === rulePack),
          ),
        ].filter(Boolean))];
        if (compatiblePackSlugs.length === 1) baseParams.set('pack', compatiblePackSlugs[0]!);
        else if (compatiblePackSlugs.length > 1) baseParams.set('packs', compatiblePackSlugs.join(','));
        else baseParams.set('pack', '__no_encounter_compatible_pack__');
        if (cid) baseParams.set('campaignId', String(cid));
        // Hazards belong to the Compendium add/drag-drop flow only. The NPC tab's picker is
        // monster-focused and its UI doesn't surface entry type, so keep it to monsters.
        const types = tab === 'compendium' ? (['monster', 'hazard'] as const) : (['monster'] as const);
        const pages = await Promise.all(
          types.map((type) => {
            const params = new URLSearchParams(baseParams);
            params.set('type', type);
            return api.get<{ items: RuleEntry[] }>(`${API}/rules/search?${params.toString()}`);
          }),
        );
        // Merging two independently-sorted result sets (monsters + hazards) would leave the
        // combined list ungrouped; re-sort by name (id tie-break) so the picker stays stable.
        if (!cancelled) {
          const merged = pages
            .flatMap((page) => page.items)
            .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
          setResults(merged);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `cid` (issue #1898 review): the encounter route renders the same component tree
    // across campaigns, so navigating to another campaign's encounter can update this
    // prop without remounting AddCombatantPanel. Without cid in the dependency list the
    // effect kept a stale closed-over campaign id until tab/query/rulePack happened to
    // change too, scoping the search (and any add) to the PREVIOUS campaign.
  }, [tab, debouncedQuery, rulePack, enabledPackSlugs, installedPacks, cid]);

  async function addManual(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    // A manual combatant has no rule-entry/character to derive HP from, so the server requires
    // hpMax explicitly. Mirror that here with a readable message instead of the round-trip's
    // dev-jargon "Unable to resolve hpMax…" (issue #146).
    if (!hpMax.trim() || !Number.isFinite(Number(hpMax)) || Number(hpMax) < 1) {
      setError('Enter max HP (a number of 1 or more) for a manual combatant.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'monster' as CombatantKind,
        name: name.trim(),
        hpMax: hpMax ? Math.max(1, Number(hpMax)) : undefined,
        initMod: initMod ? Number(initMod) : undefined,
        count: parseCount(manualCount),
        statblock: manualStatblock,
      });
      setName('');
      setHpMax('');
      setInitMod('');
      setManualCount('1');
      setManualStatblock(defaultCombatantStatblock());
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addFromLibrary(entry: CampaignLibraryMonster, hpOverride?: number) {
    setSaving(true);
    setError(null);
    try {
      // Issue #2080, and the regression a review caught on PR #2086's first attempt at
      // this fix: entries saved before this field existed (or saved with HP left blank)
      // have no `entry.statblock.hp` to seed from, and the Library tab is the ONLY place
      // a DM can add them — the Manual tab's HP field is a different form entirely. This
      // resolves `hpMax` in priority order, highest first:
      //   1. `hpOverride` — typed into THIS entry's own inline HP input, rendered on its
      //      Library-tab card only when `entry.statblock.hp` is null (below). This is what
      //      makes a pre-#2080 entry addable again without switching tabs.
      //   2. `manualOverride` — the Manual tab's shared HP field has no visible input on
      //      the Library tab, so a value here can only be a deliberate override the DM
      //      typed before switching over. Kept for entries that DO have a stored HP.
      //   3. Neither present: no hpMax is sent at all, and the server seeds it from the
      //      saved statblock's template HP (entry.statblock.hp) — the same value the DM
      //      typed when they saved this entry. (The old code guessed "10" right here
      //      whenever hpMax was blank — silently discarding whatever HP the entry
      //      actually carried, or claimed one it never had.) A stored HP of `null` with
      //      no override supplied surfaces an explicit, translated error instead.
      const manualOverride = hpMax.trim() && Number.isFinite(Number(hpMax)) ? Math.max(1, Number(hpMax)) : undefined;
      const resolvedOverride = hpOverride ?? manualOverride;
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'monster' as CombatantKind,
        name: entry.name,
        libraryMonsterId: entry.id,
        ...(resolvedOverride !== undefined ? { hpMax: resolvedOverride } : {}),
        count: parseCount(manualCount),
      });
      if (hpOverride !== undefined) {
        setLibraryHpDrafts((prev) => {
          if (!(entry.id in prev)) return prev;
          const next = { ...prev };
          delete next[entry.id];
          return next;
        });
      }
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function saveManualToLibrary() {
    if (!name.trim()) {
      setError('Enter a name before saving to the campaign library.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Issue #2080: carry the HP the DM typed into the library entry's statblock
      // template, instead of dropping it on the floor. `manualStatblock.hp` is nullable,
      // so "present" here means numeric — not merely non-undefined — and the check is
      // written explicitly rather than via `??`, which would treat an explicit `null`
      // (the statblock HP field left blank/cleared) the same as "absent" without saying
      // so. Only a NUMERIC statblock HP (set directly through the statblock editor's own
      // Max HP field) overrides this tab's separate "HP" field — the value from the bug's
      // reported repro steps — parsed the same way addManual validates it. Neither
      // present: save `hp: null` explicitly (a real, representable "unknown"), never a
      // guessed number.
      const hpFromField = hpMax.trim() && Number.isFinite(Number(hpMax)) ? Math.max(1, Number(hpMax)) : null;
      const hpToSave = typeof manualStatblock.hp === 'number' ? manualStatblock.hp : hpFromField;
      await api.post(`${API}/campaigns/${cid}/library/monsters`, {
        name: name.trim(),
        statblock: { ...manualStatblock, hp: hpToSave },
      });
      const list = await api.get<CampaignLibraryMonster[]>(`${API}/campaigns/${cid}/library/monsters`);
      setLibrary(list);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addFromCompendium(entry: RuleEntry) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'monster' as CombatantKind,
        // Optional override lets the DM rename ("Goblin" -> "Goblin archer") at add time;
        // otherwise the statblock name is used. count>1 auto-suffixes 1..N server-side.
        name: nameOverride.trim() || entry.name,
        ruleEntryId: entry.id,
        count: parseCount(compCount),
      });
      setNameOverride('');
      setCompCount('1');
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addDroppedRuleEntry(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (saving) return;
    let payload: { id?: unknown; name?: unknown; type?: unknown };
    try {
      payload = JSON.parse(event.dataTransfer.getData('application/x-campfire-rule-entry'));
    } catch {
      // Ignore unrelated/invalid drags; the drop zone accepts only Campfire rule entries.
      return;
    }
    if (
      typeof payload.id !== 'number' ||
      typeof payload.name !== 'string' ||
      (payload.type !== 'monster' && payload.type !== 'hazard')
    ) return;
    const droppedType = payload.type;
    const droppedId = payload.id;
    setSaving(true);
    setError(null);
    try {
      // Resolve the FULL entry from the rules read path (the drag payload only carries
      // id/name/type, but RuleEntry requires many more fields — trusting a cast would
      // mask bugs). Confirm the resolved type still matches what was dragged before adding.
      const url = `${API}/rules/entries/${droppedId}${cid ? `?campaignId=${cid}` : ''}`;
      const entry = await api.get<RuleEntry>(url);
      if (entry.type !== droppedType) {
        setError("That compendium entry doesn't match the dragged monster/hazard anymore.");
        return;
      }
      await addFromCompendium(entry);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addAllFromParty() {
    const available = characters.filter((c) => !existingCombatantCharacterIds.has(c.id));
    if (available.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await Promise.all(
        available.map((character) =>
          api.post(`${API}/encounters/${encounterId}/combatants`, {
            kind: 'character' as CombatantKind,
            characterId: character.id,
            name: character.name,
            hpMax: character.hpMax,
          }),
        ),
      );
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  async function addFromParty(character: Character) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'character' as CombatantKind,
        characterId: character.id,
        name: character.name,
        hpMax: character.hpMax,
      });
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  // Add the selected NPC as a combatant. With a statblock `entry` it borrows that
  // statblock's HP (like a compendium add); otherwise it uses the manual HP field.
  async function addFromNpc(entry?: RuleEntry) {
    const npcIdNum = Number(selectedNpcId);
    if (!selectedNpcId || !Number.isFinite(npcIdNum)) {
      setError('Pick an NPC to add.');
      return;
    }
    if (!entry && (!npcHp.trim() || !Number.isFinite(Number(npcHp)) || Number(npcHp) < 1)) {
      setError('Enter max HP (1 or more), or pick a statblock, for this NPC.');
      return;
    }
    const npc = npcs.find((n) => n.id === npcIdNum);
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/encounters/${encounterId}/combatants`, {
        kind: 'npc' as CombatantKind,
        npcId: npcIdNum,
        name: npc?.name,
        ruleEntryId: entry?.id,
        hpMax: entry ? undefined : Math.max(1, Number(npcHp)),
        initMod: npcInit ? Number(npcInit) : undefined,
      });
      setNpcHp('');
      setNpcInit('');
      await onAdded();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.addCombatant' }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      className="space-y-3"
      data-testid="add-combatant-dropzone"
      onDragOver={(event: React.DragEvent) => {
        if (event.dataTransfer.types.includes('application/x-campfire-rule-entry')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(event: React.DragEvent<HTMLElement>) => void addDroppedRuleEntry(event)}
    >
      <span className="card-kicker">{t('encounters.run.addCombatant')}</span>
      <p className="text-muted" style={{ fontSize: 11, margin: 0 }}>
        {t('encounters.run.addCombatantHint')}
      </p>
      <div
        className="seg seg-wrap self-start inline-flex max-w-full"
        role="tablist"
        aria-label={t('encounters.run.addCombatant')}
        data-testid="add-combatant-tabs"
      >
        {ADD_TAB_ORDER.map((t) => {
          const selectedTab = tab === t;
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`add-combatant-tab-${t}`}
              aria-selected={selectedTab}
              aria-controls={`add-combatant-panel-${t}`}
              tabIndex={selectedTab ? 0 : -1}
              onClick={() => selectAddTab(t)}
              onKeyDown={onAddTabKeyDown}
              className="cf-target-44"
              style={{
                padding: '7px 13px',
                font: 'inherit',
                fontSize: 12,
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                color: selectedTab ? 'var(--color-accent)' : 'var(--color-text)',
                boxShadow: selectedTab ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
              }}
            >
              {ADD_TAB_LABELS[t]}
            </button>
          );
        })}
      </div>

      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}

      <div
        id="add-combatant-panel-manual"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-manual"
        tabIndex={0}
        hidden={tab !== 'manual'}
        className={tab === 'manual' ? 'space-y-3' : 'hidden'}
      >
        <form onSubmit={addManual} className="flex gap-2 flex-wrap items-end">
          <div className="field" style={{ flex: 1, minWidth: 140 }}>
            <label htmlFor="add-combatant-name">Name</label>
            <TextInput id="add-combatant-name" placeholder="Ashen cultist" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label htmlFor="add-combatant-hp">HP</label>
            <TextInput id="add-combatant-hp" aria-label="Max HP" placeholder="22" value={hpMax} onChange={(e) => setHpMax(e.target.value)} />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label htmlFor="add-combatant-init">Init mod</label>
            <TextInput id="add-combatant-init" aria-label="Initiative modifier" placeholder="2" value={initMod} onChange={(e) => setInitMod(e.target.value)} />
          </div>
          <div className="field" style={{ width: 70 }}>
            <label htmlFor="add-combatant-count">Qty</label>
            <TextInput id="add-combatant-count" type="number" min={1} max={50} aria-label="Quantity — adds this many, auto-numbered" value={manualCount} onChange={(e) => setManualCount(e.target.value)} />
          </div>
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Adding…' : 'Add'}
          </Btn>
          <Btn type="button" ghost disabled={saving || !name.trim()} onClick={() => void saveManualToLibrary()}>
            Save to library
          </Btn>
        </form>
        <p className="text-[11px] text-muted m-0" title={COMBATANT_STATBLOCK_HELP.library}>
          {COMBATANT_STATBLOCK_HELP.library}
        </p>
        <CombatantStatblockEditor value={manualStatblock} onChange={setManualStatblock} disabled={saving} ruleSystem={rulePack} customMechanicsProfile={customMechanicsProfile} />
      </div>

      <div
        id="add-combatant-panel-library"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-library"
        tabIndex={0}
        hidden={tab !== 'library'}
        className={tab === 'library' ? 'space-y-2' : 'hidden'}
      >
        {library.length === 0 ? (
          <p className="text-muted text-sm">No saved homebrew monsters yet. Build one on the Manual tab and save it to the library.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {library.map((entry) => {
              const hpKnown = entry.statblock.hp != null;
              const hpDraft = libraryHpDrafts[entry.id] ?? '';
              const hpDraftValid = hpDraft.trim() !== '' && Number.isFinite(Number(hpDraft)) && Number(hpDraft) >= 1;

              if (hpKnown) {
                return (
                  <Card
                    key={entry.id}
                    type="button"
                    density="compact" elev="sm" as="button" className="text-left"
                    style={{ border: 0, font: 'inherit', color: 'var(--color-text)', cursor: 'pointer', padding: '8px 12px' }}
                    disabled={saving}
                    onClick={() => void addFromLibrary(entry)}
                  >
                    <span className="font-medium">{entry.name}</span>
                    <span className="text-muted text-xs block">
                      {entry.statblock.actions.length} action{entry.statblock.actions.length === 1 ? '' : 's'}
                      {' · '}
                      {t('encounters.run.library.hpValue', { hp: entry.statblock.hp })}
                    </span>
                  </Card>
                );
              }

              // Issue #2080 (regression fix): entries with no stored HP — every entry saved
              // before this field existed, or saved with HP left blank — cannot be added by
              // a single click on the card; the server has nothing to seed `hpMax` from and
              // the Library tab is the only place the DM can supply one. Render an explicit
              // HP input + Add button instead of the click-anywhere card above (an <input>
              // cannot nest inside a <button>).
              return (
                <Card
                  key={entry.id}
                  as="div"
                  density="compact" elev="sm"
                  style={{ padding: '8px 12px' }}
                  className="flex flex-wrap items-end gap-2"
                >
                  <div className="flex-1" style={{ minWidth: 120 }}>
                    <span className="font-medium block">{entry.name}</span>
                    <span className="text-muted text-xs block">
                      {entry.statblock.actions.length} action{entry.statblock.actions.length === 1 ? '' : 's'}
                      {' · '}
                      {t('encounters.run.library.hpNotSet')}
                    </span>
                  </div>
                  <div className="field" style={{ width: 80 }}>
                    <label htmlFor={`library-hp-${entry.id}`} className="sr-only">
                      {t('encounters.run.library.hpOverrideLabel')}
                    </label>
                    <TextInput
                      id={`library-hp-${entry.id}`}
                      aria-label={t('encounters.run.library.hpOverrideLabel')}
                      placeholder={t('encounters.run.library.hpOverridePlaceholder')}
                      value={hpDraft}
                      disabled={saving}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setLibraryHpDrafts((prev) => ({ ...prev, [entry.id]: raw }));
                      }}
                    />
                  </div>
                  <Btn
                    type="button"
                    disabled={saving || !hpDraftValid}
                    onClick={() => void addFromLibrary(entry, Math.max(1, Number(hpDraft)))}
                  >
                    {t('encounters.run.library.addWithHp')}
                  </Btn>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <div
        id="add-combatant-panel-compendium"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-compendium"
        tabIndex={0}
        hidden={tab !== 'compendium'}
        className={tab === 'compendium' ? 'space-y-2' : 'hidden'}
      >
        <TextInput
            aria-label="Search monsters and hazards in the compendium"
            placeholder="Search monsters and hazards…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* Quantity + optional name override for the next pick (issue #114): adding
              N monsters auto-numbers them "Goblin 1".."Goblin N" so they're distinguishable. */}
          <div className="flex gap-2 flex-wrap items-end">
            <div className="field" style={{ width: 70 }}>
              <label htmlFor="comp-count">Qty</label>
              <TextInput id="comp-count" type="number" min={1} max={50} aria-label="Quantity to add" value={compCount} onChange={(e) => setCompCount(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 140 }}>
              <label htmlFor="comp-name-override">Name override (optional)</label>
              <TextInput id="comp-name-override" placeholder="Leave blank to use statblock name" value={nameOverride} onChange={(e) => setNameOverride(e.target.value)} />
            </div>
          </div>
          {searching ? (
            <Skeleton lines={2} />
          ) : results.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 12 }}>
              {query.trim() ? 'No matches.' : 'Start typing to search the compendium.'}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {results.map((entry) => (
                <Card
                  key={entry.id}
                  density="compact" elev="sm" as="button"
                  style={{
                    border: 0,
                    font: 'inherit',
                    color: 'var(--color-text)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                  }}
                  disabled={saving}
                  onClick={() => addFromCompendium(entry)}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{entry.name}</span>
                  {entry.campaignId != null && (
                    <span className="tag tag-amber" data-testid="homebrew-badge">
                      {t('compendium.homebrew', 'Homebrew')}
                    </span>
                  )}
                  <span className="tag tag-neutral">
                    {entry.type}
                  </span>
                </Card>
              ))}
            </div>
          )}
      </div>

      <div
        id="add-combatant-panel-party"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-party"
        tabIndex={0}
        hidden={tab !== 'party'}
        className={tab === 'party' ? 'space-y-1.5' : 'hidden'}
      >
        {(() => {
            const available = characters.filter((c) => !existingCombatantCharacterIds.has(c.id));
            if (characters.length === 0) {
              return (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  No characters in this campaign yet.
                </p>
              );
            }
            if (available.length === 0) {
              return (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  The whole party is already in this encounter.
                </p>
              );
            }
            return (
              <>
                <Btn
                  type="button"
                  ghost
                  data-testid="add-whole-party-button"
                  disabled={saving}
                  onClick={addAllFromParty}
                  className="w-full text-xs mb-2"
                >
                  {t('encounters.addWholeParty', { count: available.length })}
                </Btn>
                {available.map((c) => (
                  <Card
                    key={c.id}
                    density="compact" elev="sm" as="button"
                    style={{
                      border: 0,
                      font: 'inherit',
                      color: 'var(--color-text)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      width: '100%',
                    }}
                    disabled={saving}
                    onClick={() => addFromParty(c)}
                  >
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{c.name}</span>
                    <span className="text-muted" style={{ fontSize: 'var(--type-meta)' }}>
                      {c.hpCurrent}/{c.hpMax}
                    </span>
                  </Card>
                ))}
              </>
            );
        })()}
      </div>

      <div
        id="add-combatant-panel-npc"
        role="tabpanel"
        aria-labelledby="add-combatant-tab-npc"
        tabIndex={0}
        hidden={tab !== 'npc'}
        className={tab === 'npc' ? 'space-y-2' : 'hidden'}
      >
        {npcs.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 12 }}>
              No NPCs in this campaign yet — create one on the NPCs page.
            </p>
          ) : (
            <>
              <div className="field">
                <label htmlFor="npc-select">NPC</label>
                <select
                  id="npc-select"
                  className="cf-select"
                  value={selectedNpcId}
                  onChange={(e) => setSelectedNpcId(e.target.value)}
                >
                  <option value="">Choose an NPC…</option>
                  {npcs.map((n) => (
                    <option key={n.id} value={String(n.id)}>
                      {n.name}
                      {n.role ? ` — ${n.role}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <form onSubmit={(e) => { e.preventDefault(); void addFromNpc(); }} className="flex gap-2 flex-wrap items-end">
                <div className="field" style={{ width: 80 }}>
                  <label htmlFor="npc-hp">HP</label>
                  <TextInput id="npc-hp" aria-label="Max HP" placeholder="22" value={npcHp} onChange={(e) => setNpcHp(e.target.value)} />
                </div>
                <div className="field" style={{ width: 80 }}>
                  <label htmlFor="npc-init">Init mod</label>
                  <TextInput id="npc-init" aria-label="Initiative modifier" placeholder="2" value={npcInit} onChange={(e) => setNpcInit(e.target.value)} />
                </div>
                <Btn type="submit" disabled={saving || !selectedNpcId}>
                  {saving ? 'Adding…' : 'Add NPC'}
                </Btn>
              </form>
              <div className="hr" style={{ margin: '4px 0' }} />
              <p className="text-muted reading-supporting">
                …or give it a statblock — search the compendium and pick one (its HP is used):
              </p>
              <TextInput
                aria-label="Search monster statblocks for this NPC"
                placeholder="Search statblocks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {searching ? (
                <Skeleton lines={2} />
              ) : results.length === 0 ? (
                <p className="text-muted" style={{ fontSize: 12 }}>
                  {query.trim() ? 'No matches.' : 'Optional — leave blank to add with manual HP above.'}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {results.map((entry) => (
                    <Card
                      key={entry.id}
                      density="compact" elev="sm" as="button"
                      style={{
                        border: 0,
                        font: 'inherit',
                        color: 'var(--color-text)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                      }}
                      disabled={saving || !selectedNpcId}
                      title={!selectedNpcId ? 'Choose an NPC first' : `Add ${entry.name}'s statblock to the selected NPC`}
                      onClick={() => void addFromNpc(entry)}
                    >
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{entry.name}</span>
                      {entry.campaignId != null && (
                        <span className="tag tag-amber" data-testid="homebrew-badge">
                          {t('compendium.homebrew', 'Homebrew')}
                        </span>
                      )}
                      <span className="tag tag-neutral">
                        statblock
                      </span>
                    </Card>
                  ))}
                </div>
              )}
            </>
          )}
      </div>
    </Card>
  );
}
