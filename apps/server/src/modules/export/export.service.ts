import { Injectable } from '@nestjs/common';
import JSZip from 'jszip';
import type { EncounterWithCombatants } from '@campfire/schema';
import { CampaignsService } from '../campaigns/campaigns.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { SessionsService } from '../sessions/sessions.service';
import { CharactersService } from '../characters/characters.service';
import { NotesService } from '../notes/notes.service';
import { MembersService } from '../membership/members.service';
import { AuditService } from '../audit/audit.service';
import { ProposalsService } from '../proposals/proposals.service';
import { EncountersService } from '../encounters/encounters.service';
import type { RequestUser } from '../../common/user.types';

/** Filesystem/URL-safe slug for filenames — lowercase, alnum + hyphens. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

@Injectable()
export class ExportService {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly sessions: SessionsService,
    private readonly characters: CharactersService,
    private readonly notes: NotesService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
    private readonly proposals: ProposalsService,
    private readonly encounters: EncountersService,
  ) {}

  /**
   * Full campaign export as the requesting dm sees it: dmSecret fields
   * included (role='dm' throughout), notes limited to what's visible to
   * THIS dm (party_shared + dm_shared + their own private notes — other
   * members' private notes are excluded, same rule as GET /notes).
   */
  async buildExport(campaignId: number, user: RequestUser) {
    const role = 'dm' as const;

    const [campaign, questList, npcList, locationList, sessionList, characterList, noteList, memberList, auditList, proposalList, encounterList] =
      await Promise.all([
        this.campaigns.getOrThrow(campaignId),
        this.quests.listForCampaignWithObjectives(campaignId, role),
        this.npcs.listForCampaign(campaignId, role),
        this.locations.listForCampaign(campaignId, role),
        this.sessions.listForCampaign(campaignId, role),
        this.characters.listForCampaign(campaignId, role),
        this.notes.listForCampaign(campaignId, user, role, {}),
        this.members.listForCampaign(campaignId),
        this.audit.listForCampaign(campaignId, 500),
        this.proposals.listForCampaign(campaignId, undefined),
        this.encounters.listForCampaign(campaignId),
      ]);

    // Encounters need their combatants too (listForCampaign only returns the bare
    // Encounter rows) — fetch each one's full detail in parallel.
    const encountersWithCombatants: EncounterWithCombatants[] = await Promise.all(
      encounterList.map((e) => this.encounters.getWithCombatantsOrThrow(e.id)),
    );

    // members "sans anything sensitive" — CampaignMember already carries no
    // password/session data, but drop nothing further needed; kept explicit
    // here in case that shape grows sensitive fields later.
    const members = memberList.map((m) => ({
      id: m.id,
      campaignId: m.campaignId,
      userId: m.userId,
      role: m.role,
      characterId: m.characterId,
      username: m.username,
      displayName: m.displayName,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    return {
      campaign,
      quests: questList,
      npcs: npcList,
      locations: locationList,
      sessions: sessionList,
      characters: characterList,
      notes: noteList,
      members,
      audit: auditList,
      proposals: proposalList,
      encounters: encountersWithCombatants,
    };
  }

  exportFilename(campaignName: string, extension: 'json' | 'zip'): string {
    const slug = slugify(campaignName);
    const date = new Date().toISOString().slice(0, 10);
    return `campfire-${slug}-${date}.${extension}`;
  }

  /** Renders the same export data as a zip of markdown files. */
  async buildMarkdownZip(campaignId: number, user: RequestUser): Promise<Buffer> {
    const data = await this.buildExport(campaignId, user);
    const zip = new JSZip();

    zip.file('campaign.md', this.campaignMarkdown(data.campaign, data.notes));

    const questsFolder = zip.folder('quests')!;
    for (const q of data.quests) {
      questsFolder.file(`${slugify(q.title)}.md`, this.questMarkdown(q));
    }

    const npcsFolder = zip.folder('npcs')!;
    for (const n of data.npcs) {
      npcsFolder.file(`${slugify(n.name)}.md`, this.npcMarkdown(n));
    }

    const locationsFolder = zip.folder('locations')!;
    for (const l of data.locations) {
      locationsFolder.file(`${slugify(l.name)}.md`, this.locationMarkdown(l));
    }

    const sessionsFolder = zip.folder('sessions')!;
    for (const s of data.sessions) {
      sessionsFolder.file(`${slugify(s.title || `session-${s.number}`)}.md`, this.sessionMarkdown(s));
    }

    const charactersFolder = zip.folder('characters')!;
    for (const c of data.characters) {
      charactersFolder.file(`${slugify(c.name)}.md`, this.characterMarkdown(c));
    }

    const encountersFolder = zip.folder('encounters')!;
    for (const e of data.encounters) {
      encountersFolder.file(`${slugify(e.name)}.md`, this.encounterMarkdown(e));
    }

    return zip.generateAsync({ type: 'nodebuffer' });
  }

  private campaignMarkdown(campaign: Awaited<ReturnType<CampaignsService['getOrThrow']>>, notes: Awaited<ReturnType<NotesService['listForCampaign']>>): string {
    const lines = [
      `# ${campaign.name}`,
      '',
      `- Status: ${campaign.status}`,
      `- Danger level: ${campaign.dangerLevel}`,
      `- Sessions played: ${campaign.sessionCount}`,
      '',
      '## Description',
      '',
      campaign.description || '_none_',
    ];
    if (notes.length) {
      lines.push('', '## Notes', '');
      for (const n of notes) {
        lines.push(`- **${n.authorName || n.authorUserId}** (${n.visibility}): ${n.body}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  private questMarkdown(q: Awaited<ReturnType<QuestsService['listForCampaignWithObjectives']>>[number]): string {
    const lines = [
      `# ${q.title}`,
      '',
      `- Status: ${q.status}`,
      `- Reward: ${q.reward || '_none_'}`,
      '',
      '## Description',
      '',
      q.body || '_none_',
    ];
    if (q.objectives.length) {
      lines.push('', '## Objectives', '');
      for (const o of q.objectives) {
        lines.push(`- [${o.done ? 'x' : ' '}] ${o.text}`);
      }
    }
    if (q.dmSecret) {
      lines.push('', '## DM Secret', '', q.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private npcMarkdown(n: Awaited<ReturnType<NpcsService['listForCampaign']>>[number]): string {
    const lines = [
      `# ${n.name}`,
      '',
      `- Role: ${n.role || '_unknown_'}`,
      `- Disposition: ${n.disposition}`,
      '',
      '## Description',
      '',
      n.body || '_none_',
    ];
    if (n.dmSecret) {
      lines.push('', '## DM Secret', '', n.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private locationMarkdown(l: Awaited<ReturnType<LocationsService['listForCampaign']>>[number]): string {
    const lines = [
      `# ${l.name}`,
      '',
      `- Kind: ${l.kind || '_unknown_'}`,
      `- Status: ${l.status}`,
      '',
      '## Description',
      '',
      l.body || '_none_',
    ];
    if (l.dmSecret) {
      lines.push('', '## DM Secret', '', l.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private sessionMarkdown(s: Awaited<ReturnType<SessionsService['listForCampaign']>>[number]): string {
    const lines = [
      `# Session ${s.number}${s.title ? `: ${s.title}` : ''}`,
      '',
      `- Played at: ${s.playedAt ?? '_unrecorded_'}`,
      '',
      '## Recap',
      '',
      s.recap || '_none_',
    ];
    if (s.dmSecret) {
      lines.push('', '## DM Secret', '', s.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private characterMarkdown(c: Awaited<ReturnType<CharactersService['listForCampaign']>>[number]): string {
    const lines = [
      `# ${c.name}`,
      '',
      `- Species: ${c.species || '_unknown_'}`,
      `- Class: ${c.className || '_unknown_'}`,
      `- Level: ${c.level}`,
      `- HP: ${c.hpCurrent}/${c.hpMax}`,
      `- AC: ${c.ac ?? '_unset_'}`,
      '',
      '## Notes',
      '',
      c.notes || '_none_',
    ];
    if (c.dmSecret) {
      lines.push('', '## DM Secret', '', c.dmSecret);
    }
    return lines.join('\n') + '\n';
  }

  private encounterMarkdown(e: EncounterWithCombatants): string {
    const lines = [
      `# ${e.name}`,
      '',
      `- Status: ${e.status}`,
      `- Round: ${e.round}`,
      '',
      '## Combatants',
      '',
    ];
    if (e.combatants.length) {
      lines.push('| Name | Kind | Initiative | HP | Conditions |', '| --- | --- | --- | --- | --- |');
      for (const c of e.combatants) {
        lines.push(
          `| ${c.name} | ${c.kind} | ${c.initiative ?? '_unrolled_'} | ${c.hpCurrent}/${c.hpMax} | ${c.conditions.length ? c.conditions.join(', ') : '_none_'} |`,
        );
      }
    } else {
      lines.push('_none_');
    }
    return lines.join('\n') + '\n';
  }
}
