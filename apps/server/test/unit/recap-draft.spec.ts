import { RECAP_HEADINGS } from '@campfire/schema';
import { buildRecapDraft, type RecapDraftSource } from '../../src/modules/sessions/sessions.service';

/**
 * Unit tests for the deterministic recap-draft builder (issue #79). It is
 * explicitly NOT an LLM call — the server just assembles structured source
 * material + the shared scaffold, so it is fully unit-testable.
 */
function source(over: Partial<RecapDraftSource> = {}): RecapDraftSource {
  return { resolvedInbox: [], encounters: [], ...over } as RecapDraftSource;
}

function encounter(name: string, status: string, foes: string[] = []): RecapDraftSource['encounters'][number] {
  return {
    name,
    status,
    combatants: foes.map((f, i) => ({ id: i + 1, kind: 'monster', name: f })),
  } as unknown as RecapDraftSource['encounters'][number];
}

function inbox(
  body: string,
  resolvedNote: string | null,
  entityName: string | null,
): RecapDraftSource['resolvedInbox'][number] {
  return { body, resolvedNote, entityName } as unknown as RecapDraftSource['resolvedInbox'][number];
}

describe('sessions — buildRecapDraft', () => {
  it('always includes the four scaffold headings', () => {
    const draft = buildRecapDraft(source());
    for (const heading of RECAP_HEADINGS) {
      expect(draft).toContain(`## ${heading}`);
    }
  });

  it('seeds fought encounters (running/ended) under the Recap heading', () => {
    const draft = buildRecapDraft(
      source({ encounters: [encounter('Goblin Ambush', 'ended', ['Goblin', 'Hobgoblin'])] }),
    );
    expect(draft).toContain('- Goblin Ambush vs Goblin, Hobgoblin');
  });

  it('omits a still-preparing encounter (prep is not play)', () => {
    const draft = buildRecapDraft(source({ encounters: [encounter('Planned Fight', 'preparing', ['Orc'])] }));
    expect(draft).not.toContain('Planned Fight');
  });

  it('lists a fought encounter with no monsters without a "vs" clause', () => {
    const draft = buildRecapDraft(source({ encounters: [encounter('Skill Challenge', 'running', [])] }));
    expect(draft).toContain('- Skill Challenge');
    expect(draft).not.toContain('Skill Challenge vs');
  });

  it('appends a "Threads resolved this session" block from resolved inbox items', () => {
    const draft = buildRecapDraft(
      source({ resolvedInbox: [inbox('Who poisoned the well?', 'The steward confessed', 'Steward Alric')] }),
    );
    expect(draft).toContain('## Threads resolved this session');
    expect(draft).toContain('- Who poisoned the well? — The steward confessed (→ Steward Alric)');
  });

  it('collapses whitespace in an inbox body', () => {
    const draft = buildRecapDraft(source({ resolvedInbox: [inbox('line one\n   line two', null, null)] }));
    expect(draft).toContain('- line one line two');
  });

  it('omits the threads block when there is no resolved inbox material', () => {
    expect(buildRecapDraft(source())).not.toContain('Threads resolved this session');
  });

  it('is deterministic for the same input', () => {
    const s = source({ encounters: [encounter('A', 'ended', ['X'])] });
    expect(buildRecapDraft(s)).toBe(buildRecapDraft(s));
  });
});
