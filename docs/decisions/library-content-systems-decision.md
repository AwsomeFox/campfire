# Decision: what "library / reusable content" should mean

- **Status:** Decided (design-only; no code changed by this document)
- **Issue:** [#1785](https://github.com/AwsomeFox/campfire/issues/1785) — "Re-examine: 'library / reusable content' is four overlapping systems wearing similar names"
- **Date:** 2026-08-07
- **Non-goal (per issue):** no data/module migrations happen here. This records the target shape; execution is follow-up issues (listed at the end).

## 1. The four systems, as they actually exist in code

| # | System | Module (server) | Scope | Storage | Who reads | Who writes |
|---|---|---|---|---|---|---|
| 1 | Compendium / rule packs | `apps/server/src/modules/rules` — `RulesController` | Server-wide | `rule_packs`, `rule_entries` (`apps/server/src/db/schema.ts:1378`, `:1401`) | any authenticated user | server-admin only (`@ServerRoles('admin')`, `rules.controller.ts:92,120,146,156,167,253`) |
| 2 | Campaign Homebrew | `rules` — `CampaignHomebrewController` (`rules.controller.ts:266-303`) | Per campaign | same `rule_entries` table, `campaignId` set (`packages/schema/src/index.ts:3562`) | campaign members | DM directly, non-DM/`proposed=true` via proposal (`rules.controller.ts:277-280,299`) |
| 3 | Campaign Library | `apps/server/src/modules/campaign-library` | Per campaign | `campaign_library_monsters`, `_tags`, `_collections`, `_templates` (`db/schema.ts:2180,2191,2196,2209`) | campaign members (search/list); DM for templates list (`campaign-library.controller.ts:146`) | DM only for every write (`requireRole(..., 'dm')` throughout `campaign-library.controller.ts`) |
| 4 | Campaign Modules | `apps/server/src/modules/campaign-modules` | Per campaign install | `campaign_module_installs`, `_artifacts`, `_snapshots` (`db/schema.ts:2439,2473,2495`) | DM only, every route including reads (`campaign-modules.controller.ts:38,51,67,82`) | DM only |

What's reusable in each, concretely:
- **1+2 (rules):** one shape, `RuleEntry` (`packages/schema/src/index.ts:3559-3605`) — `packId`, optional `campaignId`, `slug`, `type`, `body`, `dataJson`, license/attribution fields. Row scope (`campaignId == null` vs set) is the only thing distinguishing "compendium" from "homebrew."
- **3 (library):** four sub-jobs living behind one controller file and one nav item:
  - Monsters: `CampaignLibraryMonster` (`packages/schema/src/combatant-statblock.ts:90-99`) — **a different shape from `RuleEntry`**: `id`, `campaignId`, `name`, a nested `CombatantStatblock` (`combatant-statblock.ts:38-57`), and `sourceRuleEntryId` (nullable link back to a compendium `RuleEntry`).
  - Entity templates: `CampaignLibraryTemplate` (`index.ts:13433`) — a `snapshot: z.unknown()` blob keyed by `LibraryEntityType`, which spans **nine** entity kinds (`index.ts:13371-13373`: quest, npc, location, faction, encounter, timeline_event, inventory_item, attachment, and — self-referentially — `campaign_library_monster`).
  - Taxonomy: `CampaignLibraryTag` / `CampaignLibraryCollection` (`index.ts:13379-13397`), each with parent-hierarchy fields.
  - Cross-entity search + bulk ops: `CampaignLibrarySearchController` (`campaign-library.controller.ts:119-177`) — `search`, `bulk`, `undo`, template CRUD, and cross-entity `duplicate`, all on one controller.
- **4 (modules):** whole packaged adventures. `MODULE_ARTIFACT_KINDS = ['location', 'npc', 'quest', 'faction']` (`apps/server/src/modules/campaign-modules/module-content.ts:38`) — **no rule entries, no monsters, no taxonomy**. Its job is install/update/fork/rollback of bundled content with 3-way merge, a materially different workflow from "pick a reusable item."

## 2. Where the code shows real duplication (not just naming)

The clearest, most concrete instance is in the encounter "add combatant" flow, `apps/web/src/features/encounters/combat/AddCombatantPanel.tsx`:

- It has five tabs: `manual`, `compendium`, `library`, `party`, `npc` (`AddCombatantPanel.tsx:20-28`).
- The **Compendium** tab already queries `/rules/search?...&campaignId=` (`AddCombatantPanel.tsx:177,185`) — i.e. it already merges global compendium *and* campaign homebrew into one search, one result list, one tab. `RulesController.search` explicitly documents this: *"Filter to one campaign to include campaign homebrew for members"* (`rules.controller.ts:190`). **Compendium and Homebrew are already functionally unified** at the surface DMs actually use — the module split (system-wide vs per-campaign row) is real but doesn't currently confuse users, because the UI never asks them to pick between two screens for it.
- The **Library** tab is a second, separately-implemented path for the same underlying job — "get a monster statblock into this fight." It fetches `GET /campaigns/:id/library/monsters` (`AddCombatantPanel.tsx:151-160`) and posts new ones back to that same collection (`AddCombatantPanel.tsx:266-284`), using the `CampaignLibraryMonster`/`CombatantStatblock` shape instead of `RuleEntry`.
- Both tabs terminate in a combatant with actions in the same `CharacterAction` shape (`combatant-statblock.ts:1-8`: manual/library monsters carry a structured `CombatantStatblock`; compendium monsters get their `RuleEntry.dataJson` expanded into the same `CharacterAction` shape at read time, in `apps/server/src/modules/encounters/action-resolver.service.ts`). **The two paths converge in behavior but diverge in storage, API, and UI** — this is the "which screen do I use?" problem made concrete, and it is monsters specifically, not the whole Library surface.

So the issue's claim that Homebrew and Library monsters "already reuse the `RuleEntry`/`CombatantStatblock` shape" is imprecise in one respect worth correcting: they do **not** share a literal schema today (`RuleEntry` vs `CampaignLibraryMonster`+`CombatantStatblock` are two different Zod types with different tables). What they share is the *job* (produce a reusable monster statblock) and a *provenance link* (`sourceRuleEntryId`). That's exactly why folding them is low-risk: there's already a foreign key pointing the way.

## 3. A claim in the issue that no longer holds against current code

> "...it's the only `prepare`-group nav item with a hardcoded English label (`Library`) in an otherwise i18n'd app."

Checked against `apps/web/src/app/campaignNav.ts:69`: the library nav entry is `label: t('nav.library')` — routed through i18n like every other nav item, not a hardcoded string. The real defect: the `ar` translation catalog carried untranslated English values across a large portion of keys (including `ar/nav.json`), which `check:i18n` previously missed because it checked key parity rather than content. This broader catalog gap was tracked in [#2059](https://github.com/AwsomeFox/campfire/issues/2059) and ratcheted in [#2064](https://github.com/AwsomeFox/campfire/pull/2064).

`CampaignLibraryPage.tsx` (83 lines, `apps/web/src/features/library/CampaignLibraryPage.tsx`) does match the issue's "dense, unformatted JSX blob" description — see the filter bar, bulk-ops panel, and taxonomy editor each written as a single very long line (`CampaignLibraryPage.tsx:77-82`). That characterization holds.

## 4. Decision — target shape

Answering the issue's three questions:

**What is "Library"?** Its primary job becomes **taxonomy (tags/collections) + cross-entity search/bulk ops for DMs** — the one sub-job that is genuinely cross-cutting and has no better home. Monsters and templates move out (below); modules were never really "Library"'s to begin with.

**Monsters → fold into Compendium/Homebrew.** `CampaignLibraryMonster` becomes a `RuleEntry` row scoped to the campaign (`campaignId` set, `type: 'monster'`), the same way homebrew already works. `sourceRuleEntryId` provenance is preserved by keeping it as a field on the entry (or reusing the existing per-entry `source`/`sourceUrl` fields). `AddCombatantPanel`'s separate `library` tab is retired — the `compendium` tab already does the merged campaign+global search that would include these. `campaign_library_monsters` and its dedicated REST/MCP surface (`list/create/update/delete/clone_campaign_library_monster`) are retired once the migration lands.

**Templates → a "Save as template" action, not a destination.** `CampaignLibraryTemplate` keeps its current generic `snapshot`-by-`LibraryEntityType` shape (it's already the right level of genericity for nine entity kinds) and keeps its own table — only the *entry point* changes, from a Library-page list to a per-entity action on each entity's own detail page (quest, npc, location, faction, encounter, …), with a lightweight "Instantiate from template" affordance offered where that entity type is created.

**Taxonomy → stays cross-cutting, and becomes what "Library" is.** Tags/collections and the search/bulk-ops console (`CampaignLibrarySearchController`) are the retained core of the `campaign-library` module. The nav label and page get a rename/rewrite to reflect the narrower job (deferred to a follow-up so it can be done together with the UI rewrite `CampaignLibraryPage.tsx` needs regardless).

**Campaign Modules is not part of this overlap and needs no change.** It installs/updates/forks whole packaged adventures (locations/npcs/quests/factions with 3-way merge) — a fundamentally different, heavier workflow than "pick a reusable item," confirmed by its artifact-kind list excluding rules/monsters/taxonomy entirely (`module-content.ts:38`). It reads as related only because "module" and "library" both suggest "reusable content" in the abstract; the code does not overlap.

## 5. Recommended follow-ups (not filed by this change — for the issue owner to prioritize)

1. Migrate `campaign_library_monsters` rows into `rule_entries` (`campaignId` set, `type: 'monster'`); retire the dedicated monster CRUD (REST + MCP) and the `library` tab in `AddCombatantPanel.tsx`, relying on the existing merged `compendium` tab / `/rules/search?campaignId=`.
2. Move "save as template" from the Library page to per-entity detail-page actions across the nine `LibraryEntityType` kinds; keep the `campaign_library_templates` table and its snapshot/instantiate/archive semantics unchanged.
3. Rewrite `CampaignLibraryPage.tsx` into readable components scoped to tags/collections + search/bulk-ops only, and update `nav.json`'s `library` key (all locales) to reflect the narrower job.
4. Translation catalog coverage for untranslated values is tracked and ratcheted in [#2059](https://github.com/AwsomeFox/campfire/issues/2059) / [#2064](https://github.com/AwsomeFox/campfire/pull/2064).
5. No action item for Campaign Modules — this decision confirms it is intentionally separate.

Each of the above is independently shippable and should be a focused issue per the parent issue's own guidance ("file focused follow-ups after a decision").
