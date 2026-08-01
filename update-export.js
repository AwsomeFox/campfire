import * as fs from 'fs';

function update() {
  const content = fs.readFileSync('apps/server/src/modules/export/export.service.ts', 'utf8');
  let newContent = content.replace(
    /async buildMemberExport\(campaignId: number, user: RequestUser, role: 'dm' \| 'player' \| 'viewer'\) \{[\s\S]*?    \};/g,
    `async buildMemberExport(campaignId: number, user: RequestUser, role: 'dm' | 'player' | 'viewer', includeCountsOnly = false) {
    const [campaign, characterList, noteList, allComments, proposalList, supportPreference, auditExport, allRolls, schedules, allRevisions] = await Promise.all([
      this.campaigns.getOrThrow(campaignId),
      this.characters.listForExport(campaignId, role),
      this.notes.listAllForCampaign(campaignId, user, role, { mine: true }),
      this.comments.listForCampaign(campaignId, role),
      this.proposals.listForCampaign(campaignId, undefined, role, { proposerUserId: user.id }),
      this.supportPreferences.getOwn(campaignId, user.id),
      this.audit.listForCampaignExport(campaignId),
      this.rolls.listForCampaign(campaignId, 999999), // Get all to filter
      this.scheduling.listForExport(campaignId),
      this.revisions.listForCampaign(campaignId),
    ]);

    const ownCharacters = characterList.filter((c) => c.ownerUserId === user.id);
    const ownProposals = proposalList;
    
    // Authored comments and replies (includes speaking-character identity)
    const ownComments = allComments.filter(c => c.authorUserId === String(user.id) || c.authorUserId === user.id);
    
    // Redacted parent context for comments to keep authored material intelligible
    const parentCommentIds = new Set(ownComments.map(c => c.parentId).filter(id => id != null));
    const parentContext = allComments
      .filter(c => parentCommentIds.has(c.id) && c.authorUserId !== String(user.id) && c.authorUserId !== user.id)
      .map(c => ({
        id: c.id,
        entityType: c.entityType,
        entityId: c.entityId,
        body: c.body,
        authorName: '[Redacted Member]',
        characterName: null,
      }));

    // RSVP state/notes
    const rsvps = schedules.flatMap(s => s.rsvps
      .filter(r => r.userId === user.id)
      .map(r => ({ ...r, scheduledSessionId: s.id, sessionTitle: s.title }))
    );

    // Dice/roll records
    const ownRolls = allRolls.filter(r => r.actor === String(user.id));

    // Personal revisions (notes and owned-character history)
    const ownRevisions = allRevisions.filter(r => r.authorUserId === user.id);

    // Attributable AI/table actions
    const ownAudit = auditExport.entries.filter(e => e.actor === String(user.id));

    const manifest = {
      version: 1,
      exportDate: new Date().toISOString(),
      userId: user.id,
      included: [
        'characters',
        'notes',
        'comments',
        'commentParentContext',
        'proposals',
        'supportPreference',
        'rsvps',
        'diceRolls',
        'revisions',
        'auditActions'
      ],
      excluded: ['campaignWorldData', 'otherMembersPrivateData', 'fullAuditLog'],
      excludedReason: 'Export is limited to player-authored content and explicitly attributable actions. Campaign world data and other members\\' private data are omitted.',
      counts: {
        characters: ownCharacters.length,
        notes: noteList.length,
        comments: ownComments.length,
        commentParentContext: parentContext.length,
        proposals: ownProposals.length,
        supportPreference: supportPreference ? 1 : 0,
        rsvps: rsvps.length,
        diceRolls: ownRolls.length,
        revisions: ownRevisions.length,
        auditActions: ownAudit.length,
      }
    };

    if (includeCountsOnly) {
      return manifest;
    }

    return {
      manifest,
      campaign: { id: campaign.id, name: campaign.name, description: campaign.description, status: campaign.status },
      exportedFor: { userId: user.id, name: user.name, role },
      characters: ownCharacters,
      notes: noteList,
      comments: ownComments,
      commentParentContext: parentContext,
      proposals: ownProposals,
      supportPreference,
      rsvps,
      diceRolls: ownRolls,
      revisions: ownRevisions,
      auditActions: ownAudit,
      note:
        'This is a MEMBER-scoped export — only the characters and support preference you own, the notes and comments ' +
        'you authored, and the proposals you submitted in this campaign. It intentionally excludes DM secrets, other members’ ' +
        'private data, and the campaign-wide bundle (that export is DM-only).',
    };`
  );
  fs.writeFileSync('apps/server/src/modules/export/export.service.ts', newContent);
}
update();
