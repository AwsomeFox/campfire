import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbHolder, DrizzleDb } from '../../src/db/db.module';
import { campaigns, combatants, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ModerationService } from '../../src/modules/moderation/moderation.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { EncountersService, redactMonsterHp } from '../../src/modules/encounters/encounters.service';
import { MembersService } from '../../src/modules/membership/members.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { UsersService } from '../../src/modules/users/users.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { CampaignLibraryService } from '../../src/modules/campaign-library/campaign-library.service';
import { RequestUser } from '../../src/common/user.types';
import { nowIso } from '../../src/common/time';

describe('Encounter controlled combatant (controllerUserId)', () => {
  let dataDir: string;
  let holder: DbHolder;
  let previousDataDir: string | undefined;
  let db: DrizzleDb;
  let encountersService: EncountersService;
  let membersService: MembersService;
  let usersService: UsersService;

  let campaignId: number;
  let encounterId: number;
  let dmUserId: number;
  let player1UserId: number;
  let player2UserId: number;

  let dmActor: RequestUser;
  let player1Actor: RequestUser;
  let player2Actor: RequestUser;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-controlled-combatant-test-'));
    process.env.DATA_DIR = dataDir;
    holder = new DbHolder();
    db = holder.proxy as DrizzleDb;

    const audit = new AuditService(db);
    const notifications = new NotificationsService(db);
    const events = new CampaignEventsService();
    const rolls = new RollsService(db);
    const revisions = new RevisionsService(db, new ModerationService(db, audit));
    const fsDeletion = new FsDeletionService(db, audit);
    const derivatives = new AttachmentDerivativesService(db);
    const attachments = new AttachmentsService(db, audit, fsDeletion, derivatives);
    const library = new CampaignLibraryService(db, audit, events);
    const notifyMock: Pick<NotificationsService, "notifyCampaign" | "notifyUser"> = {
      notifyCampaign: jest.fn().mockResolvedValue(undefined),
      notifyUser: jest.fn().mockResolvedValue(undefined),
    };

    encountersService = new EncountersService(db, audit, events, rolls, revisions, attachments, library, notifyMock as unknown as NotificationsService);
    membersService = new MembersService(db, audit, notifications, events);
    usersService = new UsersService(db, audit);

    const dmUser = await usersService.create({ username: 'dm', displayName: 'DM', password: 'pw' });
    const p1User = await usersService.create({ username: 'p1', displayName: 'Player 1', password: 'pw' });
    const p2User = await usersService.create({ username: 'p2', displayName: 'Player 2', password: 'pw' });

    dmUserId = dmUser.id;
    player1UserId = p1User.id;
    player2UserId = p2User.id;

    dmActor = { id: String(dmUserId), name: 'DM', serverRole: 'user' };
    player1Actor = { id: String(player1UserId), name: 'Player 1', serverRole: 'user' };
    player2Actor = { id: String(player2UserId), name: 'Player 2', serverRole: 'user' };

    const [camp] = await db
      .insert(campaigns)
      .values({ name: 'Controlled Combatant Campaign', createdAt: nowIso(), updatedAt: nowIso() })
      .returning();
    campaignId = camp.id;

    await membersService.create(campaignId, { userId: dmUserId, role: 'dm' }, dmActor);
    await membersService.create(campaignId, { userId: player1UserId, role: 'player' }, dmActor);
    await membersService.create(campaignId, { userId: player2UserId, role: 'player' }, dmActor);

    const [enc] = await db
      .insert(encounters)
      .values({ campaignId, name: 'Summoned Wolf Fight', status: 'planning', createdAt: nowIso(), updatedAt: nowIso() })
      .returning();
    encounterId = enc.id;
  });

  afterEach(() => {
    holder.onApplicationShutdown();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('DM can add a combatant with controllerUserId, non-DM cannot', async () => {
    // Non-DM attempts to set controllerUserId -> Forbidden
    await expect(
      encountersService.addCombatant(
        encounterId,
        { kind: 'monster', name: 'Dire Wolf', hpMax: 30, controllerUserId: player1UserId },
        player1Actor,
        'player',
      ),
    ).rejects.toThrow(ForbiddenException);

    // DM sets non-member user ID -> BadRequestException
    await expect(
      encountersService.addCombatant(
        encounterId,
        { kind: 'monster', name: 'Dire Wolf', hpMax: 30, controllerUserId: 999999 },
        dmActor,
        'dm',
      ),
    ).rejects.toThrow(BadRequestException);

    // DM sets valid member user ID -> Success
    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: 'monster', name: 'Dire Wolf', hpMax: 30, controllerUserId: player1UserId },
      dmActor,
      'dm',
    );
    expect(combatant.controllerUserId).toBe(player1UserId);
  });

  it('DM can set/clear controllerUserId via updateCombatant, non-DM cannot', async () => {
    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: 'monster', name: 'Mount', hpMax: 40 },
      dmActor,
      'dm',
    );
    expect(combatant.controllerUserId).toBeNull();

    // Non-DM trying to assign controllerUserId -> Forbidden
    await expect(
      encountersService.updateCombatant(
        encounterId,
        combatant.id,
        { controllerUserId: player1UserId },
        player1Actor,
        'player',
      ),
    ).rejects.toThrow(ForbiddenException);

    // DM assigns controllerUserId to player 1
    const updated = await encountersService.updateCombatant(
      encounterId,
      combatant.id,
      { controllerUserId: player1UserId },
      dmActor,
      'dm',
    );
    expect(updated.controllerUserId).toBe(player1UserId);

    // DM clears controllerUserId back to null
    const cleared = await encountersService.updateCombatant(
      encounterId,
      combatant.id,
      { controllerUserId: null },
      dmActor,
      'dm',
    );
    expect(cleared.controllerUserId).toBeNull();
  });

  it('un-redacts exact HP for controller player while keeping statblock DM-only', async () => {
    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: 'monster', name: 'Summoned Elemental', hpMax: 50, controllerUserId: player1UserId },
      dmActor,
      'dm',
    );

    // DM sees exact HP and statblock
    expect(combatant.hpCurrent).toBe(50);
    expect(combatant.hpMax).toBe(50);

    // Player 1 (controller) sees exact HP via redactMonsterHp helper
    const p1Redacted = redactMonsterHp(combatant, player1UserId);
    expect(p1Redacted.hpCurrent).toBe(50);
    expect(p1Redacted.hpMax).toBe(50);
    expect(p1Redacted.statblock).toBeNull(); // statblock remains DM-only

    // Player 2 (non-controller spectator) has redacted HP
    const p2Redacted = redactMonsterHp(combatant, player2UserId);
    expect(p2Redacted.hpCurrent).toBeNull();
    expect(p2Redacted.hpMax).toBeNull();
    expect(p2Redacted.statblock).toBeNull();
  });

  it('allows controller player to edit HP, conditions, and token on controlled combatant', async () => {
    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: 'monster', name: 'Familiar', hpMax: 10, controllerUserId: player1UserId },
      dmActor,
      'dm',
    );

    // Non-controller player cannot edit combatant -> Forbidden
    await expect(
      encountersService.updateCombatant(
        encounterId,
        combatant.id,
        { hpDelta: -3 },
        player2Actor,
        'player',
      ),
    ).rejects.toThrow(ForbiddenException);

    // Controller player can update HP
    const patchedHp = await encountersService.updateCombatant(
      encounterId,
      combatant.id,
      { hpDelta: -3 },
      player1Actor,
      'player',
    );
    expect(patchedHp.hpCurrent).toBe(7);

    // Controller player can update token position
    const patchedToken = await encountersService.updateCombatant(
      encounterId,
      combatant.id,
      { tokenX: 45, tokenY: 60 },
      player1Actor,
      'player',
    );
    expect(patchedToken.tokenX).toBe(45);
    expect(patchedToken.tokenY).toBe(60);
  });

  it('allows controller player to roll initiative for controlled combatant', async () => {
    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: 'monster', name: 'Companion Bear', hpMax: 25, controllerUserId: player1UserId },
      dmActor,
      'dm',
    );

    // Non-controller player cannot roll initiative -> Forbidden
    await expect(
      encountersService.rollCombatantInitiative(encounterId, combatant.id, 'key1', false, player2Actor, 'player'),
    ).rejects.toThrow(ForbiddenException);

    // Controller player can roll initiative
    const res = await encountersService.rollCombatantInitiative(encounterId, combatant.id, 'key2', false, player1Actor, 'player');
    expect(res.combatant.initiative).toBeGreaterThan(0);
  });

  it('clears controllerUserId when the controlling member is removed from campaign', async () => {
    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: 'monster', name: 'Delegated Beast', hpMax: 20, controllerUserId: player1UserId },
      dmActor,
      'dm',
    );
    expect(combatant.controllerUserId).toBe(player1UserId);

    // Find player 1's campaign member row id
    const members = await membersService.listForCampaign(campaignId);
    const p1Member = members.find((m) => m.userId === player1UserId)!;

    // Remove player 1 from campaign
    await membersService.remove(campaignId, p1Member.id, dmActor);

    // Verify combatant's controllerUserId was reset to null
    const rows = await db.select().from(combatants);
    expect(rows[0].controllerUserId).toBeNull();
  });
  it("rejects assigning a viewer-role member as controllerUserId", async () => {
    const viewerUser = await usersService.create({ username: "v1", displayName: "Viewer 1", password: "pw" });
    await membersService.create(campaignId, { userId: viewerUser.id, role: "viewer" }, dmActor);

    await expect(
      encountersService.addCombatant(
        encounterId,
        { kind: "monster", name: "Mount", hpMax: 30, controllerUserId: viewerUser.id },
        dmActor,
        "dm",
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows delegated controller player to end turn when it is their combatants turn", async () => {
    const combatant = await encountersService.addCombatant(
      encounterId,
      { kind: "monster", name: "Summoned Imp", hpMax: 15, controllerUserId: player1UserId },
      dmActor,
      "dm",
    );
    await encountersService.updateCombatant(encounterId, combatant.id, { initiative: 20 }, dmActor, "dm");
    await encountersService.start(encounterId, dmActor, "dm");

    // Controlling player can end turn for the active controlled combatant
    const res = await encountersService.endTurn(encounterId, {}, player1Actor, "player");
    expect(res).toBeDefined();
  });
});
