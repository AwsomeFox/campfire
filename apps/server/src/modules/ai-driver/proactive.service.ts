/**
 * Proactive DM service (#1044). Subscribes to campaign events and triggers
 * autonomous AI DM turns when game conditions are met (encounter ended, HP
 * critical, objective completed). Budget-metered and rate-limited.
 */

import { BadRequestException, ConflictException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { CampaignEventsService } from '../events/campaign-events.service';
import { AiDriverService, isMidTurnFrozenState } from './ai-driver.service';
import { AiDmService } from '../ai-dm/ai-dm.service';
import type { AiDmProactiveSettings, CampaignEvent } from '@campfire/schema';

// Proactive trigger types and their corresponding event patterns
const TRIGGER_EVENT_MAP: Record<string, string[]> = {
  encounterEnded: ['encounter.ended'],
  hpCritical: ['character.updated'],  // Filtered further by HP threshold
  objectiveCompleted: ['quest.objective_completed', 'quest.completed'],
  npcTurn: ['encounter.turn_changed'],
};

// Proactive prompt templates per trigger type
const PROACTIVE_PROMPTS: Record<string, string> = {
  encounterEnded: [
    'The encounter has just ended. As the DM, consider:',
    '- Suggesting a short rest if the party took significant damage',
    '- Highlighting interesting loot or environmental details',
    '- Advancing the narrative naturally to the next scene',
    '- Offering quest hooks or environmental observations',
    'Respond naturally in character as the DM. Keep it concise.',
  ].join('\n'),
  hpCritical: [
    'A party member\'s HP has dropped to a critical level (below 25%).',
    'As the DM, consider:',
    '- Acknowledging the danger in the narrative',
    '- Subtly reminding about healing options if appropriate',
    '- Adjusting the environmental tension',
    'Do NOT break immersion. Respond naturally.',
  ].join('\n'),
  objectiveCompleted: [
    'A quest objective has been completed.',
    'As the DM, consider:',
    '- Acknowledging the achievement',
    '- Revealing what comes next in the story',
    '- Offering new quest hooks or branching paths',
    'Respond naturally in character as the DM.',
  ].join('\n'),
  npcTurn: [
    'It is now an NPC or monster turn in the encounter.',
    'As the DM, take their combat turn:',
    '- Resolve their action, movement, or spell using tools',
    '- Narrate the action briefly and clearly',
    '- Advance to the next turn when finished using end_turn',
  ].join('\n'),
};

interface ProactiveCampaignState {
  subscription: Subscription;
  lastTriggerAt: number;
  tokensUsedThisHour: number;
  hourWindowStart: number;
}

@Injectable()
export class ProactiveService implements OnModuleDestroy {
  private readonly logger = new Logger(ProactiveService.name);
  private readonly campaigns = new Map<number, ProactiveCampaignState>();

  constructor(
    private readonly events: CampaignEventsService,
    private readonly driver: AiDriverService,
    private readonly aiDm: AiDmService,
  ) {
    if (typeof this.aiDm.registerProactiveSettingsCallback !== 'function') {
      this.logger.error(
        'AiDmService.registerProactiveSettingsCallback is unavailable; proactive watching will not start',
      );
      return;
    }
    this.aiDm.registerProactiveSettingsCallback((campaignId, settings, seatEnabled) => {
      if (settings) {
        if (settings.enabled && seatEnabled !== false) {
          this.startWatching(campaignId, settings);
        } else {
          this.stopWatching(campaignId);
        }
      } else if (seatEnabled === false) {
        this.stopWatching(campaignId);
      }
    });
  }

  onModuleDestroy(): void {
    for (const [, state] of this.campaigns) {
      state.subscription.unsubscribe();
    }
    this.campaigns.clear();
  }

  /**
   * Start watching a campaign for proactive trigger events.
   * Called when a seat is configured with proactiveSettings.enabled = true.
   */
  startWatching(campaignId: number, settings: AiDmProactiveSettings): void {
    this.stopWatching(campaignId);

    const relevantEvents = new Set<string>();
    for (const [trigger, events] of Object.entries(TRIGGER_EVENT_MAP)) {
      if (settings.triggers[trigger as keyof typeof settings.triggers]) {
        for (const e of events) relevantEvents.add(e);
      }
    }

    if (relevantEvents.size === 0) {
      this.logger.debug(`Campaign ${campaignId}: no proactive triggers enabled, skipping`);
      return;
    }

    const subscription = this.events.streamFor(campaignId).pipe(
      filter((event: CampaignEvent) => relevantEvents.has(event.type)),
    ).subscribe({
      next: (event) => void this.handleEvent(campaignId, event, settings).catch(
        (err) => this.logger.error(`Proactive trigger failed for campaign ${campaignId}: ${err.message}`, err.stack),
      ),
    });

    this.campaigns.set(campaignId, {
      subscription,
      lastTriggerAt: 0,
      tokensUsedThisHour: 0,
      hourWindowStart: Date.now(),
    });

    this.logger.log(`Campaign ${campaignId}: proactive watching started (${[...relevantEvents].join(', ')})`);
  }

  /** Stop watching a campaign. */
  stopWatching(campaignId: number): void {
    const state = this.campaigns.get(campaignId);
    if (state) {
      state.subscription.unsubscribe();
      this.campaigns.delete(campaignId);
      this.logger.log(`Campaign ${campaignId}: proactive watching stopped`);
    }
  }

  /** Check if a campaign is being watched. */
  isWatching(campaignId: number): boolean {
    return this.campaigns.has(campaignId);
  }

  /**
   * Manually trigger a proactive turn (POST /ai-dm/trigger).
   */
  async manualTrigger(campaignId: number, triggerType: string, customPrompt?: string): Promise<void> {
    if (!customPrompt && !(triggerType in TRIGGER_EVENT_MAP)) {
      throw new BadRequestException(`Unknown proactive trigger type: ${triggerType}`);
    }
    const prompt = customPrompt ?? PROACTIVE_PROMPTS[triggerType];
    await this.executeProactiveTurn(campaignId, triggerType, prompt);
  }

  private async handleEvent(
    campaignId: number,
    event: CampaignEvent,
    settings: AiDmProactiveSettings,
  ): Promise<void> {
    const state = this.campaigns.get(campaignId);
    if (!state) return;

    // Determine trigger type from event
    const triggerType = this.classifyEvent(event, settings);
    if (!triggerType) return;

    // Cooldown check
    const now = Date.now();
    const cooldownMs = settings.cooldownSeconds * 1000;
    if (now - state.lastTriggerAt < cooldownMs) {
      this.logger.debug(`Campaign ${campaignId}: proactive trigger '${triggerType}' skipped (cooldown)`);
      return;
    }

    // Hourly token budget check
    if (now - state.hourWindowStart > 3_600_000) {
      state.tokensUsedThisHour = 0;
      state.hourWindowStart = now;
    }
    if (state.tokensUsedThisHour >= settings.maxProactiveTokensPerHour) {
      this.logger.debug(`Campaign ${campaignId}: proactive trigger '${triggerType}' skipped (hourly token budget)`);
      return;
    }

    // Check driver session isn't busy or frozen (paused / human_control)
    const session = this.driver.getSession(campaignId);
    if (session.status === 'running' || isMidTurnFrozenState(session.state)) {
      this.logger.debug(`Campaign ${campaignId}: proactive trigger '${triggerType}' skipped (turn in progress or frozen)`);
      return;
    }

    state.lastTriggerAt = now;
    const prompt = PROACTIVE_PROMPTS[triggerType];
    if (!prompt) return;

    await this.executeProactiveTurn(campaignId, triggerType, prompt);
  }

  private classifyEvent(event: CampaignEvent, settings: AiDmProactiveSettings): string | null {
    if ((event.type as string) === 'encounter.ended' && settings.triggers.encounterEnded) {
      return 'encounterEnded';
    }
    if (event.type === 'character.updated' && settings.triggers.hpCritical) {
      // HP critical is checked by examining the event payload — only trigger if
      // the character's HP dropped below 25% of max
      // The event data may include characterId; actual HP check happens in executeProactiveTurn
      const char = (event as any).data;
      if (char && char.hp !== undefined && char.maxHp !== undefined) {
          if (char.hp < (char.maxHp * 0.25)) {
              return 'hpCritical';
          }
      } else {
        return null;
      }
    }
    if (((event.type as string) === 'quest.objective_completed' || (event.type as string) === 'quest.completed') &&
        settings.triggers.objectiveCompleted) {
      return 'objectiveCompleted';
    }
    if (event.type === 'encounter.turn_changed' && settings.triggers.npcTurn) {
      if (event.turnReverted) return null;
      const kind = event.combatantKind;
      if (kind && kind !== 'character') {
        return 'npcTurn';
      }
    }
    return null;
  }

  private async executeProactiveTurn(campaignId: number, triggerType: string, prompt: string): Promise<void> {
    this.logger.log(`Campaign ${campaignId}: executing proactive turn (trigger: ${triggerType})`);

    try {
      const result = await this.driver.runTurn(campaignId, this.driver.systemActor(), prompt, {
        proactive: true,
        maxSteps: 3,  // Proactive turns should be brief
        maxTokens: 512,
      });

      // Meter proactive token usage
      const state = this.campaigns.get(campaignId);
      if (state && result?.tokensUsed) {
        state.tokensUsedThisHour += result.tokensUsed;
      }

      this.logger.log(`Campaign ${campaignId}: proactive turn completed (${result?.tokensUsed ?? 0} tokens)`);
    } catch (err: unknown) {
      // ConflictException (409) means a turn is already running — that's fine, skip
      if (err instanceof ConflictException) {
        this.logger.debug(`Campaign ${campaignId}: proactive turn skipped (conflict)`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Campaign ${campaignId}: proactive turn failed (${triggerType}): ${message}`);
    }
  }
}
