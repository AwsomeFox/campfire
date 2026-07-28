import { expect, test } from '@playwright/test';
import {
  displayStatusLabel,
  focusCastWindow,
  isCastDisplayStatusForCampaign,
  navigateCastWindow,
  openCastWindow,
} from '../../src/features/screen/castWindow';

test.describe('cast display window controller', () => {
  test('opens a named popup synchronously and reuses it on the next gesture', () => {
    const calls: unknown[][] = [];
    const target = { closed: false } as Window;
    const open = (...args: unknown[]) => { calls.push(args); return target; };
    expect(openCastWindow(open as Window['open'])).toBe(target);
    expect(openCastWindow(open as Window['open'])).toBe(target);
    expect(calls).toEqual([
      ['', 'campfire-player-display', 'popup,width=1280,height=720,noopener=false'],
      ['', 'campfire-player-display', 'popup,width=1280,height=720,noopener=false'],
    ]);
  });

  test('surfaces popup blocking and close/reopen recovery', () => {
    expect(openCastWindow((() => null) as Window['open'])).toBeNull();
    const target = { closed: true, focus: () => undefined } as unknown as Window;
    expect(focusCastWindow(target)).toBe(false);
    expect(displayStatusLabel('window-closed', null)).toMatch(/closed.*open display/i);
  });

  test('reconnects a live-but-not-ready named window by navigating it, while a ready window can focus', () => {
    let focused = 0;
    let replaced = '';
    const target = {
      closed: false,
      focus: () => { focused += 1; },
      location: { replace: (url: string) => { replaced = url; } },
    } as unknown as Window;
    expect(focusCastWindow(target)).toBe(true);
    expect(navigateCastWindow(target, 'https://campfire.test/cast/7/capability')).toBe(true);
    expect(focused).toBe(1);
    expect(replaced).toBe('https://campfire.test/cast/7/capability');
  });

  test('has explicit connected/followed-encounter status for tablet and keyboard users', () => {
    expect(displayStatusLabel('popup-blocked', null)).toMatch(/allow popups/i);
    expect(displayStatusLabel('ready', { encounterId: 42, encounterName: 'Goblin Ambush', isCurrentEncounter: true }))
      .toBe('Display connected · following Goblin Ambush');
    expect(displayStatusLabel('ready', { encounterId: 77, encounterName: 'Dragon Lair', isCurrentEncounter: false }))
      .toBe('Display connected · following another encounter (Dragon Lair)');
    expect(displayStatusLabel('ready', { encounterId: null, encounterName: null, isCurrentEncounter: false }))
      .toBe('Display connected · no running encounter');
  });

  test('filters display ready/closed updates by campaign and accepts encounter switches only when complete', () => {
    expect(isCastDisplayStatusForCampaign(
      { type: 'ready', campaignId: 7, encounterId: 42, encounterName: 'Goblin Ambush' },
      7,
    )).toBe(true);
    expect(isCastDisplayStatusForCampaign(
      { type: 'ready', campaignId: 7, encounterId: 77, encounterName: 'Dragon Lair' },
      7,
    )).toBe(true);
    expect(isCastDisplayStatusForCampaign({ type: 'closed', campaignId: 7 }, 7)).toBe(true);
    expect(isCastDisplayStatusForCampaign({ type: 'ready', campaignId: 8, encounterId: 42, encounterName: 'Wrong table' }, 7)).toBe(false);
    expect(isCastDisplayStatusForCampaign({ type: 'ready', campaignId: 7, encounterId: 42 }, 7)).toBe(false);
  });
});
