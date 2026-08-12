/**
 * Component-render coverage for issue #1310: "Draft with AI" button and modal
 * for timeline_event target.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import '../../src/i18n';
import { DraftWithAiButton } from '../../src/features/ai-dm/DraftWithAiButton';

vi.mock('../../src/features/ai-dm/useDraftWithAiAvailable', () => ({
  useDraftWithAiAvailable: () => true,
}));

describe('DraftWithAiButton for timeline_event target (issue #1310)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('renders Draft with AI button and opens modal for timeline_event', async () => {
    render(
      <DraftWithAiButton
        campaignId={1}
        target="timeline_event"
        label="Draft with AI"
      />,
    );

    const button = screen.getByRole('button', { name: /Draft with AI/i });
    expect(button).toBeDefined();

    fireEvent.click(button);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(screen.getByText('Draft a timeline event with AI')).toBeDefined();
  });

  test('renders Edit with AI button for rewriting an existing timeline event', async () => {
    render(
      <DraftWithAiButton
        campaignId={1}
        target="timeline_event"
        label="Edit with AI"
        entityId={42}
        currentContent={{ title: 'Battle of Red Valley', prose: 'Minor skirmish.' }}
      />,
    );

    const button = screen.getByRole('button', { name: /Edit with AI/i });
    expect(button).toBeDefined();

    fireEvent.click(button);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
  });
});
