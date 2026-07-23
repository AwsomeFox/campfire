import { request, type APIRequestContext, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One-time backend seed for the web E2E suite (issue #81).
 *
 * Builds a deterministic, fully role-scoped fixture against a fresh server:
 *  - first-run /auth/setup   -> `admin` (server admin)
 *  - admin creates users     -> `dm`, `player`, `viewer` (serverRole 'user')
 *  - `dm` creates a campaign -> becomes its DM; adds player + viewer as members
 *  - `dm` creates an NPC with a dmSecret (the visibility fixture)
 *  - `dm` creates a running encounter with two monsters at known initiative/HP
 *    (the combat-tracker turn/HP-redaction fixture)
 *
 * Then it captures a real cookie-session storageState per role so specs just
 * `test.use({ storageState })` and land already-authenticated. Seed ids are
 * written to e2e/.auth/seed.json for specs to read.
 *
 * Everything goes through the public HTTP API (no DB poking), so the seed also
 * doubles as a smoke test that the whole auth + membership + encounter stack
 * boots and agrees with the client.
 */

// __dirname is provided by Playwright's CJS transform (this file is not run as an
// ES module), so avoid import.meta here — it isn't available in that context.
export const AUTH_DIR = resolve(__dirname, '.auth');

export const CREDS = {
  admin: { username: 'admin', password: 'campfire-admin-pw-1' },
  dm: { username: 'dm', password: 'campfire-dm-pw-1' },
  player: { username: 'player', password: 'campfire-player-pw-1' },
  viewer: { username: 'viewer', password: 'campfire-viewer-pw-1' },
} as const;

/** The dmSecret string that must be visible to the DM and invisible to everyone else. */
export const NPC_SECRET = 'THE-INNKEEPER-IS-A-DISGUISED-DRAGON';
export const NPC_NAME = 'Bram the Innkeeper';
export const QUEST_NEXT_OBJECTIVE =
  'Follow the moonlit switchback through the ruined observatory, compare the weathered star-map inscriptions, and bring the encoded waystone fragment to the Lantern Archivist before the midsummer bell rings — waypoint-' +
  'emberglasswaypointemberglasswaypointemberglasswaypointemberglasswaypointemberglass.';

export const MONSTERS = [
  { name: 'Goblin Boss', hpMax: 30, initiative: 18 },
  { name: 'Goblin Skirmisher', hpMax: 12, initiative: 7 },
] as const;

const STATBLOCK_DATA = {
  type: 'Construct',
  size: 'Large',
  challengeRating: 8,
  armorClass: 18,
  hitPoints: 126,
  speed: { walk: 30, unit: 'feet' },
  abilityScores: { strength: 20, dexterity: 12, constitution: 18, intelligence: 8, wisdom: 14, charisma: 10 },
  specialAbilities: [{ name: 'Immutable Form', desc: 'The sentinel is immune to effects that would alter its form.' }],
  actions: [
    { name: 'Multiattack', desc: 'The sentinel makes two arc blade attacks.' },
    {
      name: 'Arc Blade',
      desc: 'The sentinel swings a crackling blade at one creature within reach.',
      attackBonus: 8,
      damage: [{ expression: '2d10 + 5', type: 'lightning' }],
    },
    {
      name: 'Static Burst',
      desc: 'Each nearby creature must make a DC 16 Dexterity saving throw or take lightning damage.',
      savingThrow: { dc: 16, ability: 'Dexterity' },
      usage: { type: 'recharge', min: 5, max: 6, label: 'Recharge 5\u20136' },
    },
  ],
  reactions: [{ name: 'Deflect', desc: 'The sentinel adds 2 to its armor class against one attack that would hit it.' }],
  legendaryActions: [
    { name: 'Sweep', desc: 'The sentinel makes one arc blade attack.', legendaryActionCost: 2 },
  ],
};

export interface SeedData {
  baseURL: string;
  campaignId: number;
  encounterId: number;
  /** Hidden source map for the Ambush encounter; fog-protected (#463). */
  mapAttachmentId: number;
  /** A second encounter that was started and then ended — must render read-only (#368). */
  endedEncounterId: number;
  /** An ended encounter attached to navigation.sessionId for post-encounter hand-off coverage (#663). */
  linkedEndedEncounterId: number;
  statblockEntryId: number;
  statblockEncounterId: number;
  npcId: number;
  xpRecipients: Record<'active' | 'retired' | 'dead' | 'inactive', { id: number; name: string; xp: number }>;
  semantic: {
    campaignId: number;
    locationId: number;
    quests: Record<'available' | 'active' | 'completed' | 'failed', { id: number; title: string }>;
    npcs: Record<'friendly' | 'neutral' | 'hostile' | 'custom', { id: number; name: string }>;
  };
  navigation: {
    questId: number;
    npcId: number;
    factionId: number;
    locationId: number;
    characterId: number;
    sessionId: number;
    noteId: number;
    timelineId: number;
    itemId: number;
    commentId: number;
    arcId: number;
    beatId: number;
    encounterId: number;
    scheduledSessionId: number;
    proposalId: number;
    /** Identity-persisted mention fixtures (issue #739). */
    identity: {
      questId: number;
      /** NPC the typed token binds to; renamed AFTER seeding so the label is stale. */
      renamedNpcId: number;
      /** Two NPCs sharing one name — plain-text mention must NOT auto-link. */
      twinAId: number;
      twinBId: number;
      /** Soft-deleted NPC — its typed token must degrade to plain text. */
      deletedNpcId: number;
    };
    /** Unicode auto-linking and role-filtering fixtures (issue #627). */
    unicode: {
      questId: number;
      arabicNpcId: number;
      hebrewNpcId: number;
      cjkTokyoNpcId: number;
      cjkKyotoNpcId: number;
      accentNpcId: number;
      combiningNpcId: number;
      emojiNpcId: number;
      mixedNpcId: number;
      hiddenNpcId: number;
      deletedNpcId: number;
    };
  };
}

async function okJson(ctx: APIRequestContext, method: 'post' | 'get' | 'put', path: string, data?: unknown) {
  const res = await ctx[method](path, data === undefined ? undefined : { data });
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`${method.toUpperCase()} ${path} -> ${res.status()} ${res.statusText()}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

async function loginContext(baseURL: string, who: keyof typeof CREDS): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  await okJson(ctx, 'post', '/api/v1/auth/login', CREDS[who]);
  return ctx;
}

async function waitForInstall(ctx: APIRequestContext, jobId: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const job = await okJson(ctx, 'get', `/api/v1/rules/packs/install-jobs/${jobId}`);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(`Rule-pack fixture install failed: ${job.error ?? 'unknown error'}`);
    if (Date.now() >= deadline) throw new Error(`Rule-pack fixture install ${jobId} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://127.0.0.1:8123';
  mkdirSync(AUTH_DIR, { recursive: true });

  // --- first-run setup: creates the server admin + its session -----------------
  const admin = await request.newContext({ baseURL });
  const status = await okJson(admin, 'get', '/api/v1/auth/status');
  if (status.setupRequired) {
    await okJson(admin, 'post', '/api/v1/auth/setup', {
      username: CREDS.admin.username,
      password: CREDS.admin.password,
      displayName: 'Server Admin',
    });
  } else {
    // Server was reused (local `reuseExistingServer`) and already seeded — re-login.
    await okJson(admin, 'post', '/api/v1/auth/login', CREDS.admin);
  }

  // --- admin provisions the three campaign users -------------------------------
  const userIds: Record<'dm' | 'player' | 'viewer', number> = { dm: 0, player: 0, viewer: 0 };
  for (const who of ['dm', 'player', 'viewer'] as const) {
    // Idempotent for reused servers: a duplicate username 409s — fall back to login+/me.
    const res = await admin.post('/api/v1/users', {
      data: { username: CREDS[who].username, password: CREDS[who].password, serverRole: 'user' },
    });
    if (res.ok()) {
      userIds[who] = (await res.json()).id;
    } else {
      const ctx = await loginContext(baseURL, who);
      userIds[who] = (await okJson(ctx, 'get', '/api/v1/me')).user.id;
      await ctx.dispose();
    }
  }

  // --- DM builds the campaign + memberships + fixtures -------------------------
  const dm = await loginContext(baseURL, 'dm');
  const campaign = await okJson(dm, 'post', '/api/v1/campaigns', { name: 'E2E — Cinderhaven' });
  const campaignId: number = campaign.id;

  // Accessibility fixtures for the AI drafting dialog + mode disclosure (#812).
  // Co-DM mode needs no provider and keeps the rest of the suite away from live-driver flows.
  await okJson(admin, 'post', '/api/v1/settings/ai/kill', { enabled: true });
  await okJson(dm, 'put', `/api/v1/campaigns/${campaignId}/ai-dm`, {
    mode: 'co_dm',
    tokenBudget: 10_000,
  });

  await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/members`, { userId: userIds.player, role: 'player' });
  await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/members`, { userId: userIds.viewer, role: 'viewer' });

  // Issue #621 browser fixture: use the public upload/search/encounter APIs so both the
  // compendium reader and combat card consume exactly the same persisted dataJson string.
  const statblockUpload = await okJson(admin, 'post', '/api/v1/rules/packs/upload', {
    source: 'upload',
    pack: {
      slug: 'e2e-open5e-actions',
      name: 'E2E Open5e action fixtures',
      version: '1',
      license: 'CC0',
    },
    entries: [
      {
        slug: 'fixture-sentinel',
        name: 'Fixture Sentinel',
        type: 'monster',
        summary: 'Large construct · CR 8',
        dataJson: JSON.stringify(STATBLOCK_DATA),
      },
    ],
  });
  await waitForInstall(admin, statblockUpload.id);
  const [statblockEntry] = await okJson(dm, 'get', '/api/v1/rules/search?q=fixture%20sentinel&type=monster&pack=e2e-open5e-actions');
  if (!statblockEntry) throw new Error('Uploaded statblock fixture was not searchable');
  const statblockEntryId: number = statblockEntry.id;

  const statblockEncounter = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/encounters`, {
    name: 'E2E — Complete Statblock',
  });
  const statblockEncounterId: number = statblockEncounter.id;
  await okJson(dm, 'post', `/api/v1/encounters/${statblockEncounterId}/combatants`, {
    kind: 'monster',
    ruleEntryId: statblockEntryId,
  });

  const npc = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/npcs`, {
    name: NPC_NAME,
    role: 'Tavern keeper',
    body: 'A round, cheerful man who runs the Ember Hearth inn.',
    dmSecret: NPC_SECRET,
  });
  const npcId: number = npc.id;

  // Cross-entity navigation fixtures (issue #438). Every searchable/mentionable
  // shape carries the same uncommon token so one browser journey can inspect the
  // complete result set, while the named records are also embedded in quest
  // markdown to exercise mention links.
  const navNpc = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/npcs`, {
    name: 'DLRNAV Wayfinder',
    role: 'Navigation fixture',
  });
  const navFaction = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/factions`, {
    name: 'DLRNAV Lantern Guild',
    body: 'Navigation fixture',
  });
  const navLocation = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/locations`, {
    name: 'DLRNAV Moon Gate',
    kind: 'Navigation fixture',
    status: 'explored',
  });
  const navCharacter = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/characters`, {
    name: 'DLRNAV Aria',
    className: 'Ranger',
    status: 'retired',
    level: 3,
    hpMax: 24,
    hpCurrent: 24,
    ac: 14,
  });
  const navSession = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/sessions`, {
    number: 1,
    title: 'DLRNAV First Crossing',
    recap: 'The party crossed the moon gate.',
    playedAt: '2026-07-21',
  });
  const navTimeline = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/timeline`, {
    title: 'DLRNAV Sundering',
    body: 'Navigation fixture',
    inWorldDate: 'Year 1',
  });
  const navArc = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/arcs`, {
    title: 'DLRNAV Ember Arc',
    summary: 'Navigation fixture',
  });
  const navBeat = await okJson(dm, 'post', `/api/v1/arcs/${navArc.id}/beats`, {
    title: 'DLRNAV Broken Oath',
    body: 'Navigation fixture',
  });
  const navItem = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/inventory`, {
    name: 'DLRNAV Compass',
    notes: 'Navigation fixture',
    ownerType: 'party',
    qty: 1,
  });
  const navNote = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/notes`, {
    body: 'DLRNAV note about the crossing',
    visibility: 'party_shared',
    entityType: 'session',
    entityId: navSession.id,
  });
  const navComment = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/comments`, {
    entityType: 'session',
    entityId: navSession.id,
    body: 'DLRNAV comment about the crossing',
  });
  const navQuest = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/quests`, {
    title: 'DLRNAV Grand Route',
    body: [
      'DLRNAV Grand Route',
      navNpc.name,
      navFaction.name,
      navLocation.name,
      navCharacter.name,
      navSession.title,
      navTimeline.title,
      navArc.title,
      navBeat.title,
    ].join(' · '),
    status: 'active',
  });
  // Identity-persisted mention fixtures (issue #739). A quest whose body embeds
  // TYPED mention tokens — `[label](/.cf/<type>/<id>)` — alongside plain-text
  // mentions of the same name. The typed tokens bind to specific records by id
  // so they survive renames and same-name collisions; the plain-text "Twin Bob"
  // appears twice and must NOT be auto-linked (ambiguous name).
  const renamedNpc = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/npcs`, {
    name: 'DLRNAV Twiceborn',
    role: 'Identity fixture',
  });
  const twinA = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/npcs`, {
    name: 'DLRNAV Twin Bob',
    role: 'Twin A',
  });
  const twinB = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/npcs`, {
    name: 'DLRNAV Twin Bob',
    role: 'Twin B',
  });
  const deadTargetNpc = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/npcs`, {
    name: 'DLRNAV Ghosttarget',
    role: 'Will be deleted',
  });
  const identityQuest = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/quests`, {
    title: 'DLRNAV Identity Links',
    body: [
      `Stale label: [DLRNAV Twiceborn](/.cf/npc/${renamedNpc.id})`,
      `Ambiguous plain text: DLRNAV Twin Bob and DLRNAV Twin Bob`,
      `Resolved twin A: [Bob A](/.cf/npc/${twinA.id})`,
      `Resolved twin B: [Bob B](/.cf/npc/${twinB.id})`,
      `Dead target: [DLRNAV Ghosttarget](/.cf/npc/${deadTargetNpc.id})`,
    ].join('\n\n'),
    status: 'active',
  });
  // Rename the once-named NPC so the typed token's authored label ("DLRNAV
  // Twiceborn") no longer matches its current name — the renderer must refresh
  // the visible label to the current name while keeping the link bound to id.
  // NPC update/delete live under /npcs/:id (not the campaigns prefix).
  const renamed = await dm.patch(`/api/v1/npcs/${renamedNpc.id}`, {
    data: { name: 'DLRNAV Reborn', role: renamedNpc.role },
  });
  if (!renamed.ok()) {
    throw new Error(`PATCH rename npc -> ${renamed.status()}: ${await renamed.text()}`);
  }
  // Soft-delete the ghost target so its typed token must degrade to plain text.
  const deleted = await dm.delete(`/api/v1/npcs/${deadTargetNpc.id}`);
  if (!deleted.ok()) {
    throw new Error(`DELETE ghosttarget npc -> ${deleted.status()}: ${await deleted.text()}`);
  }

  // Unicode mention fixtures (issue #627). The quest intentionally mixes RTL,
  // CJK without spaces, canonical-equivalent Latin spellings, emoji, adjacent
  // markdown-created text nodes, and protected elements.
  const unicodeNpc = async (name: string, extra: Record<string, unknown> = {}) =>
    okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/npcs`, {
      name,
      role: 'Unicode mention fixture',
      ...extra,
    });
  const unicodeArabic = await unicodeNpc('زيد');
  const unicodeHebrew = await unicodeNpc('דוד');
  const unicodeTokyo = await unicodeNpc('東京');
  const unicodeKyoto = await unicodeNpc('京都');
  const unicodeAccent = await unicodeNpc('Café');
  const unicodeCombining = await unicodeNpc('Éclair');
  const unicodeEmoji = await unicodeNpc('守り🐉');
  const unicodeMixed = await unicodeNpc('Asha龍');
  await unicodeNpc('Amélie');
  await unicodeNpc('AME\u0301LIE');
  const unicodeHidden = await unicodeNpc('سر مخفي', { hidden: true });
  const unicodeDeleted = await unicodeNpc('亡霊');
  const unicodeQuest = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/quests`, {
    title: 'Unicode mention matrix',
    body: [
      '# زيد protected heading',
      'زيد، **زيد**؛ زيد.',
      'דוד! 東京京都。',
      'CAFE\u0301 meets E\u0301CLAIR; 守り🐉 and Asha龍.',
      'Partial guards: supercaféine مرحبازيد שלוםדוד.',
      'Canonical ambiguity: Ame\u0301lie.',
      'Hidden target: سر مخفي.',
      'Deleted target: 亡霊.',
      'Existing link: [زيد](https://example.com/existing).',
      'Inline code: `زيد`.',
      '```text\nزيد\n```',
      '<pre>زيد</pre>',
      '<script>زيد</script>',
    ].join('\n\n'),
    status: 'active',
  });
  const deletedUnicode = await dm.delete(`/api/v1/npcs/${unicodeDeleted.id}`);
  if (!deletedUnicode.ok()) {
    throw new Error(`DELETE Unicode target npc -> ${deletedUnicode.status()}: ${await deletedUnicode.text()}`);
  }
  const navEncounter = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/encounters`, {
    name: 'DLRNAV Bridge Ambush',
    questId: navQuest.id,
    locationId: navLocation.id,
    sessionId: navSession.id,
  });
  const navScheduledSession = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/schedule`, {
    title: 'DLRNAV Saturday Game',
    scheduledAt: '2032-07-24T19:30:00.000Z',
    notes: 'DLRNAV bring level five sheets.',
  });
  const proposed = await dm.patch(`/api/v1/sessions/${navSession.id}?proposed=true`, {
    data: { title: navSession.title },
  });
  if (!proposed.ok()) {
    throw new Error(`PATCH proposed session -> ${proposed.status()}: ${await proposed.text()}`);
  }
  const navProposal = (await proposed.json()).proposal;

  // Issue #744: a campaign can have at most one live fight at a time, and the
  // main "Ambush" encounter below must be the RUNNING fight downstream
  // combat-tracker/log tests key off of. Create and fully retire the ended
  // fixtures FIRST (each goes preparing -> running -> ended), so the live-fight
  // slot is free when "Ambush" is started and stays that way.

  // A linked ended encounter exercises the session-aware branch of the concise
  // post-encounter hand-off (#663). The fixture only needs a completed lifecycle
  // plus a valid same-campaign session relation. Start requires at least one
  // combatant with initiative (issue #469), so seed a throwaway monster first.
  const linkedEndedEncounter = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/encounters`, {
    name: 'Linked Aftermath at the Moon Gate',
    sessionId: navSession.id,
  });
  const linkedEndedEncounterId: number = linkedEndedEncounter.id;
  {
    const linkedCombatant = await okJson(dm, 'post', `/api/v1/encounters/${linkedEndedEncounterId}/combatants`, {
      kind: 'monster',
      name: MONSTERS[0].name,
      hpMax: MONSTERS[0].hpMax,
    });
    const patched = await dm.patch(`/api/v1/encounters/${linkedEndedEncounterId}/combatants/${linkedCombatant.id}`, {
      data: { initiative: MONSTERS[0].initiative },
    });
    if (!patched.ok()) {
      throw new Error(`PATCH linked ended combatant initiative -> ${patched.status()}: ${await patched.text()}`);
    }
  }
  await okJson(dm, 'post', `/api/v1/encounters/${linkedEndedEncounterId}/start`);
  await okJson(dm, 'post', `/api/v1/encounters/${linkedEndedEncounterId}/end`);

  // A second encounter that gets started then ENDED — used to assert the run screen is
  // read-only once status is 'ended' (issue #368): no per-combatant HP controls fire a
  // PATCH the server would reject via assertMutable.
  const endedEncounter = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/encounters`, {
    name: 'Aftermath at the Ember Hearth',
  });
  const endedEncounterId: number = endedEncounter.id;
  const endedCombatant = await okJson(dm, 'post', `/api/v1/encounters/${endedEncounterId}/combatants`, {
    kind: 'monster',
    name: MONSTERS[0].name,
    hpMax: MONSTERS[0].hpMax,
  });
  {
    const patched = await dm.patch(`/api/v1/encounters/${endedEncounterId}/combatants/${endedCombatant.id}`, {
      data: { initiative: MONSTERS[0].initiative },
    });
    if (!patched.ok()) {
      throw new Error(`PATCH ended combatant initiative -> ${patched.status()}: ${await patched.text()}`);
    }
  }
  await okJson(dm, 'post', `/api/v1/encounters/${endedEncounterId}/start`);
  await okJson(dm, 'post', `/api/v1/encounters/${endedEncounterId}/end`);

  const encounter = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/encounters`, {
    name: 'Ambush at the Ember Hearth',
  });
  const encounterId: number = encounter.id;

  // Issue #463 fixture: the encounter uses a hidden source map with active fog.
  // Browser specs assert the canvas loads the role-safe encounter route and that a
  // real player session cannot fetch this attachment directly.
  const mapUpload = await dm.post(`/api/v1/campaigns/${campaignId}/attachments`, {
    multipart: {
      kind: 'map',
      file: {
        name: 'fog-security-map.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          '89504e470d0a1a0a0000000d49484452000000010000000108020000009077' +
            '53de0000000c4944415408d763f8ffff3f0005fe02fea1399e1e0000000049454e44ae426082',
          'hex',
        ),
      },
    },
  });
  if (!mapUpload.ok()) throw new Error(`POST map fixture -> ${mapUpload.status()}: ${await mapUpload.text()}`);
  const mapAttachmentId: number = (await mapUpload.json()).id;
  const mapPatch = await dm.patch(`/api/v1/encounters/${encounterId}`, {
    data: { mapAttachmentId, fog: { enabled: true, revealed: [] } },
  });
  if (!mapPatch.ok()) throw new Error(`PATCH encounter map -> ${mapPatch.status()}: ${await mapPatch.text()}`);

  for (const m of MONSTERS) {
    const c = await okJson(dm, 'post', `/api/v1/encounters/${encounterId}/combatants`, {
      kind: 'monster',
      name: m.name,
      hpMax: m.hpMax,
    });
    // Fix initiative deterministically (roll-initiative is random) so turn order is stable.
    const patched = await dm.patch(`/api/v1/encounters/${encounterId}/combatants/${c.id}`, {
      data: { initiative: m.initiative },
    });
    if (!patched.ok()) {
      throw new Error(`PATCH combatant initiative -> ${patched.status()}: ${await patched.text()}`);
    }
  }
  // Start the fight: status -> running, round 1, current actor = highest initiative.
  // Started LAST (issue #744) so it remains the campaign's single authoritative live
  // fight for the combat-tracker and combat-log-accessibility suites.
  await okJson(dm, 'post', `/api/v1/encounters/${encounterId}/start`);

  // Party-XP fixtures (#814) are created after encounter setup so the active PC
  // does not alter the combat-trackers' already-pinned rosters.
  const xpRecipients = {} as SeedData['xpRecipients'];
  for (const fixture of [
    { status: 'active', name: 'XP Aria Active', xp: 100 },
    { status: 'retired', name: 'XP Borin Retired', xp: 200 },
    { status: 'dead', name: 'XP Cora Dead', xp: 300 },
    { status: 'inactive', name: 'XP Dain Inactive', xp: 400 },
  ] as const) {
    const character = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/characters`, fixture);
    xpRecipients[fixture.status] = { id: character.id, name: fixture.name, xp: fixture.xp };
  }

  // Isolated status/disposition spectrum for issue #875. Keeping this in its own
  // campaign makes list/dashboard visual snapshots deterministic and gives related
  // quest cards a single canonical source NPC + location.
  const semanticCampaign = await okJson(dm, 'post', '/api/v1/campaigns', { name: 'E2E — Semantic Spectrum' });
  const semanticCampaignId: number = semanticCampaign.id;

  const semanticLocation = await okJson(dm, 'post', `/api/v1/campaigns/${semanticCampaignId}/locations`, {
    name: 'Semantic Crossroads',
    kind: 'Test fixture',
    status: 'explored',
  });
  const semanticNpcs = {} as SeedData['semantic']['npcs'];
  for (const fixture of [
    { key: 'friendly', name: 'Semantic Friendly NPC', disposition: 'friendly', locationId: semanticLocation.id },
    { key: 'neutral', name: 'Semantic Neutral NPC', disposition: 'neutral' },
    { key: 'hostile', name: 'Semantic Hostile NPC', disposition: 'hostile' },
    // This used to match the list/detail substring heuristic. It must now be neutral.
    { key: 'custom', name: 'Semantic Trusted Ally NPC', disposition: 'trusted ally' },
  ] as const) {
    const { key, ...npcFixture } = fixture;
    const created = await okJson(dm, 'post', `/api/v1/campaigns/${semanticCampaignId}/npcs`, npcFixture);
    semanticNpcs[key] = { id: created.id, name: fixture.name };
  }

  const semanticQuests = {} as SeedData['semantic']['quests'];
  for (const fixture of [
    { status: 'available', title: 'Semantic Available Quest' },
    { status: 'active', title: 'Semantic Active Quest' },
    { status: 'completed', title: 'Semantic Completed Quest' },
    { status: 'failed', title: 'Semantic Failed Quest' },
  ] as const) {
    const created = await okJson(dm, 'post', `/api/v1/campaigns/${semanticCampaignId}/quests`, {
      ...fixture,
      giverNpcId: semanticNpcs.friendly.id,
      body: `${fixture.title} body`,
    });
    semanticQuests[fixture.status] = { id: created.id, title: fixture.title };
  }

  const completedObjective = await okJson(dm, 'post', `/api/v1/quests/${semanticQuests.active.id}/objectives`, {
    text: 'Recover the weathered star map',
    sortOrder: 10,
  });
  await okJson(dm, 'post', `/api/v1/quests/${semanticQuests.active.id}/objectives`, {
    text: QUEST_NEXT_OBJECTIVE,
    sortOrder: 20,
  });
  await okJson(dm, 'post', `/api/v1/quests/${semanticQuests.active.id}/objectives`, {
    text: 'Return to the observatory after the archive visit',
    sortOrder: 30,
  });
  const completedPatch = await dm.patch(
    `/api/v1/quests/${semanticQuests.active.id}/objectives/${completedObjective.id}`,
    { data: { done: true } },
  );
  if (!completedPatch.ok()) {
    throw new Error(`PATCH semantic objective -> ${completedPatch.status()}: ${await completedPatch.text()}`);
  }

  // --- capture a real session storageState per role ----------------------------
  await admin.storageState({ path: resolve(AUTH_DIR, 'admin.json') });
  await dm.storageState({ path: resolve(AUTH_DIR, 'dm.json') });

  const player = await loginContext(baseURL, 'player');
  await player.storageState({ path: resolve(AUTH_DIR, 'player.json') });

  const viewer = await loginContext(baseURL, 'viewer');
  await viewer.storageState({ path: resolve(AUTH_DIR, 'viewer.json') });

  const seed: SeedData = {
    baseURL,
    campaignId,
    encounterId,
    mapAttachmentId,
    endedEncounterId,
    linkedEndedEncounterId,
    statblockEntryId,
    statblockEncounterId,
    npcId,
    xpRecipients,
    semantic: {
      campaignId: semanticCampaignId,
      locationId: semanticLocation.id,
      quests: semanticQuests,
      npcs: semanticNpcs,
    },
    navigation: {
      questId: navQuest.id,
      npcId: navNpc.id,
      factionId: navFaction.id,
      locationId: navLocation.id,
      characterId: navCharacter.id,
      sessionId: navSession.id,
      noteId: navNote.id,
      timelineId: navTimeline.id,
      itemId: navItem.id,
      commentId: navComment.id,
      arcId: navArc.id,
      beatId: navBeat.id,
      encounterId: navEncounter.id,
      scheduledSessionId: navScheduledSession.id,
      proposalId: navProposal.id,
      identity: {
        questId: identityQuest.id,
        renamedNpcId: renamedNpc.id,
        twinAId: twinA.id,
        twinBId: twinB.id,
        deletedNpcId: deadTargetNpc.id,
      },
      unicode: {
        questId: unicodeQuest.id,
        arabicNpcId: unicodeArabic.id,
        hebrewNpcId: unicodeHebrew.id,
        cjkTokyoNpcId: unicodeTokyo.id,
        cjkKyotoNpcId: unicodeKyoto.id,
        accentNpcId: unicodeAccent.id,
        combiningNpcId: unicodeCombining.id,
        emojiNpcId: unicodeEmoji.id,
        mixedNpcId: unicodeMixed.id,
        hiddenNpcId: unicodeHidden.id,
        deletedNpcId: unicodeDeleted.id,
      },
    },
  };
  writeFileSync(resolve(AUTH_DIR, 'seed.json'), JSON.stringify(seed, null, 2));

  await Promise.all([admin.dispose(), dm.dispose(), player.dispose(), viewer.dispose()]);
}
