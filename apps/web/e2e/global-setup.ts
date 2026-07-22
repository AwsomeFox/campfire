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

export const MONSTERS = [
  { name: 'Goblin Boss', hpMax: 30, initiative: 18 },
  { name: 'Goblin Skirmisher', hpMax: 12, initiative: 7 },
] as const;

export interface SeedData {
  baseURL: string;
  campaignId: number;
  encounterId: number;
  /** A second encounter that was started and then ended — must render read-only (#368). */
  endedEncounterId: number;
  npcId: number;
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
    proposalId: number;
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
  const proposed = await dm.patch(`/api/v1/sessions/${navSession.id}?proposed=true`, {
    data: { title: navSession.title },
  });
  if (!proposed.ok()) {
    throw new Error(`PATCH proposed session -> ${proposed.status()}: ${await proposed.text()}`);
  }
  const navProposal = (await proposed.json()).proposal;

  const encounter = await okJson(dm, 'post', `/api/v1/campaigns/${campaignId}/encounters`, {
    name: 'Ambush at the Ember Hearth',
  });
  const encounterId: number = encounter.id;

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
  await okJson(dm, 'post', `/api/v1/encounters/${encounterId}/start`);

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
    endedEncounterId,
    npcId,
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
      proposalId: navProposal.id,
    },
  };
  writeFileSync(resolve(AUTH_DIR, 'seed.json'), JSON.stringify(seed, null, 2));

  await Promise.all([admin.dispose(), dm.dispose(), player.dispose(), viewer.dispose()]);
}
