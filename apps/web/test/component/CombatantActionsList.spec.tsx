/**
 * Component-render coverage for the group-action entry point (issue #1922) on
 * `CombatantActionsList`. A source-scan test can confirm the `onUseGroupAction` prop and its
 * "Run for group" button exist in the file; it cannot tell whether the button is actually
 * wired to the callback, whether it disappears for a caller that omits the prop (the
 * player/viewer and non-monster/NPC gating `RunSessionPage` applies before ever passing it
 * down), or whether the sync-gate `disabledReason` reaches it the same way it reaches "Use".
 * This test renders the real component against a mocked `GET .../actions` response and drives
 * the actual buttons.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UsableAction } from '@campfire/schema';
import '../../src/i18n';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(async (_path: string) => [] as UsableAction[]),
}));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: getMock,
    },
  };
});

import { CombatantActionsList } from '../../src/features/encounters/CombatantActionsList';

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

const ACTION: UsableAction = {
  index: 0,
  name: 'Shortbow',
  kind: '',
  mode: 'attack',
  toHit: '+4',
  damage: '1d6+2',
  notes: '',
  resolvable: true,
  spec: {
    mode: 'attack',
    attack: { bonus: '', ability: '', proficient: true, vs: 'ac' },
    save: { ability: '', dc: { kind: 'none', dc: 10, ability: '', proficient: true, bonus: 0, base: 8 } },
    cost: { slot: 'action', count: 1 },
    uses: { max: 0, recharge: '', concentration: false, repeatSave: false, spellLevel: 0, resourceKey: '', resourceCost: 0 },
    range: { range: '', shape: '', size: '' },
    targets: { count: 1, allow: 'enemy' },
    outcomes: {},
    provenance: { ruleSystem: '', source: '', ref: '' },
  },
  source: '',
};

function renderList(overrides: Partial<Parameters<typeof CombatantActionsList>[0]> = {}) {
  getMock.mockResolvedValue([ACTION]);
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CombatantActionsList
        encounterId={1}
        combatantId={101}
        enabled
        onUseAction={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe('CombatantActionsList group-action entry point (issue #1922)', () => {
  test('renders "Run for group" beside "Use" when onUseGroupAction is provided', async () => {
    renderList({ onUseGroupAction: vi.fn() });
    await waitFor(() => expect(screen.getByText('Use')).toBeTruthy());
    expect(screen.getByText('Run for group')).toBeTruthy();
  });

  test('omits "Run for group" when the caller does not pass onUseGroupAction (player/viewer or non-monster-npc gating)', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('Use')).toBeTruthy());
    expect(screen.queryByText('Run for group')).toBeNull();
  });

  test('clicking "Run for group" calls back with the action index, name, spec, and full action row', async () => {
    const onUseGroupAction = vi.fn();
    renderList({ onUseGroupAction });
    const button = await waitFor(() => screen.getByText('Run for group'));
    fireEvent.click(button);
    expect(onUseGroupAction).toHaveBeenCalledWith(0, 'Shortbow', ACTION.spec, ACTION);
  });

  test('the sync gate disables both "Use" and "Run for group" with the same reason', async () => {
    renderList({ onUseGroupAction: vi.fn(), disabledReason: 'Reconnecting…' });
    const useButton = await waitFor(() => screen.getByText('Use'));
    const groupButton = screen.getByText('Run for group');
    expect((useButton as HTMLButtonElement).disabled).toBe(true);
    expect((groupButton as HTMLButtonElement).disabled).toBe(true);
  });
});
