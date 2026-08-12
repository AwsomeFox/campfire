/**
 * Component-render coverage for issue #1325: AI image generation button and wizard modal
 * for faction and location entity targets.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import '../../src/i18n';
import { AiPortraitButton } from '../../src/features/ai-portrait/AiPortraitWizard';

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn(async (path: string) => {
    if (path.includes('/ai-portraits/readiness')) {
      return {
        method: 'external-instructions',
        warnings: ['No image-capable provider configured.'],
        cost: { imageCount: 0, tokensUsed: 0, estimatedUsd: null },
        moderation: { flagged: false, categories: [], note: null },
        capabilities: null,
      };
    }
    return {};
  }),
}));

vi.mock('../../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: postMock,
    },
  };
});

describe('AiPortraitWizard for Faction and Location targets (issue #1325)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('opens wizard modal for faction target with pre-filled prompt', async () => {
    render(
      <AiPortraitButton
        campaignId={1}
        target={{ type: 'faction', id: 42 }}
        initialPrompt="Heraldic emblem for Iron Guild"
      />,
    );

    const button = screen.getByTestId('ai-portrait-toggle');
    expect(button).toBeDefined();
    expect(button.textContent).toContain('AI image');

    fireEvent.click(button);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Heraldic emblem for Iron Guild');
  });

  test('opens wizard modal for location target with pre-filled prompt', async () => {
    render(
      <AiPortraitButton
        campaignId={1}
        target={{ type: 'location', id: 84 }}
        initialPrompt="Fantasy landmark landscape of Whispering Woods"
      />,
    );

    const button = screen.getByTestId('ai-portrait-toggle');
    fireEvent.click(button);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Fantasy landmark landscape of Whispering Woods');
  });
});
