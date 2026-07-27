import { describe, it, expect } from '@jest/globals';
import {
  citationHref,
  detectUnsupportedApplicationClaims,
  evaluateGrounding,
  GROUNDING_BLOCK_END,
  GROUNDING_BLOCK_START,
  GROUNDING_CITATION_CONTRACT,
  GroundingDeltaFilter,
  harvestRetrievals,
  hasAppliedWrite,
  parseGroundingBlock,
  RetrievalLedger,
  type AppliedToolSummary,
  type ParsedGrounding,
} from '../../src/modules/ai-driver/driver-grounding';
import { classifyStuck } from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #577 — AI Driver grounding: creative narration vs. factual rules/canon claims.
 *
 * The premise under test is adversarial, not cooperative: a model that will invent a rule will
 * also invent a citation for that rule. So every assertion below is about what the SERVER can
 * prove from its own retrieval ledger, never about what the model claimed. The ledger is written
 * only by the runtime at the point of an authorized, campaign-scoped, permission-checked read,
 * which is why membership in it doubles as an existence + scope + authorized-retrieval proof.
 */

const CAMPAIGN = 7;

function block(json: unknown): string {
  return `${GROUNDING_BLOCK_START}\n${JSON.stringify(json)}\n${GROUNDING_BLOCK_END}`;
}

function verdictFor(
  narration: string,
  ledger: RetrievalLedger,
  executed: AppliedToolSummary[] = [],
  parsedOverride?: ParsedGrounding,
) {
  const parsed = parsedOverride ?? parseGroundingBlock(narration);
  return evaluateGrounding({
    campaignId: CAMPAIGN,
    narration: parsed.narration,
    parsed,
    ledger,
    executed,
    provider: 'mock',
    model: 'mock-model-1',
  });
}

describe('#577 grounding — parsing the citation block', () => {
  it('strips the machine-readable block from the narration the table sees', () => {
    const raw = `The torch gutters as you step into the vault.\n\n${block({ claims: [] })}`;
    const parsed = parseGroundingBlock(raw);
    expect(parsed.narration).toBe('The torch gutters as you step into the vault.');
    expect(parsed.narration).not.toContain('GROUNDING');
    expect(parsed.present).toBe(true);
    expect(parsed.malformed).toBe(false);
  });

  it('keeps every word of prose — stripping the block is framing removal, not censorship', () => {
    const prose = 'A long, purple, deliberately florid paragraph about mushrooms.';
    expect(parseGroundingBlock(`${prose}\n${block({ claims: [] })}`).narration).toBe(prose);
  });

  it('treats a reply with no block as pure narration (no claims, not malformed)', () => {
    const parsed = parseGroundingBlock('You feel a draft from the east passage.');
    expect(parsed).toEqual({
      narration: 'You feel a draft from the east passage.',
      claims: [],
      present: false,
      malformed: false,
    });
  });

  it('flags an unparseable block instead of quietly accepting the turn', () => {
    const parsed = parseGroundingBlock(`Narration.\n${GROUNDING_BLOCK_START}\nnot json at all\n${GROUNDING_BLOCK_END}`);
    expect(parsed.malformed).toBe(true);
    expect(parsed.narration).toBe('Narration.');
  });

  it('strips a block truncated mid-stream rather than leaking half-serialized JSON', () => {
    const parsed = parseGroundingBlock(`Narration.\n${GROUNDING_BLOCK_START}\n{"claims":[{"text":"pa`);
    expect(parsed.narration).toBe('Narration.');
    expect(parsed.malformed).toBe(true);
  });

  it('defaults an unrecognized `kind` to a factual claim rather than waving it through', () => {
    // `kind` is a model-controlled field; the conservative direction is to demand a source.
    const parsed = parseGroundingBlock(
      `x\n${block({ claims: [{ text: 'The vault is warded.', kind: 'definitely-just-vibes', cites: [] }] })}`,
    );
    expect(parsed.claims[0].kind).toBe('canon');
  });

  it('bounds the number of claims and citations a single block can declare', () => {
    const claims = Array.from({ length: 100 }, () => ({
      text: 'x',
      kind: 'canon',
      cites: Array.from({ length: 50 }, () => ({ type: 'npc', id: 1 })),
    }));
    const parsed = parseGroundingBlock(`x\n${block({ claims })}`);
    expect(parsed.claims.length).toBeLessThanOrEqual(24);
    expect(parsed.claims[0].cites.length).toBeLessThanOrEqual(8);
  });
});

describe('#577 grounding — the retrieval ledger is written by the server, not the model', () => {
  it('records the entity id a per-entity read was called with', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'get_npc', { npcId: 42 }, JSON.stringify({ id: 42, name: 'Kaeda' }));
    expect(ledger.get('npc', 42)).toMatchObject({ tool: 'get_npc', ok: true });
  });

  it('seeds every id a campaign summary actually handed the model', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(
      ledger,
      'get_campaign_summary',
      { campaignId: CAMPAIGN },
      JSON.stringify({
        campaign: { id: CAMPAIGN, name: 'Ashfall' },
        npcs: [{ id: 11, name: 'Kaeda' }],
        quests: [{ id: 21, title: 'The Sunstone', objectives: [{ id: 9, text: 'find it' }] }],
        locations: [{ id: 31 }],
        characters: [{ id: 41 }],
      }),
    );
    expect(ledger.get('npc', 11)).toBeDefined();
    expect(ledger.get('quest', 21)).toBeDefined();
    expect(ledger.get('location', 31)).toBeDefined();
    expect(ledger.get('character', 41)).toBeDefined();
    // The nested objective id must NOT be typed as a quest — a structural walk that mistypes
    // children would hand the model citeable ids it never actually saw as quests.
    expect(ledger.get('quest', 9)).toBeUndefined();
  });

  it('records rule entry ids returned by a compendium lookup', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(
      ledger,
      'lookup_rule',
      { query: 'fireball' },
      JSON.stringify([{ id: 501, name: 'Fireball' }, { id: 502, name: 'Delayed Blast Fireball' }]),
    );
    expect(ledger.get('rule', 501)).toBeDefined();
    expect(ledger.get('rule', 502)).toBeDefined();
  });

  it('marks an errored read as a failed retrieval rather than dropping it', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'get_npc', { npcId: 999 }, '{"error":{"status":404}}', false);
    expect(ledger.get('npc', 999)).toMatchObject({ ok: false });
  });

  it('lets a later successful read upgrade an earlier failed one, never the reverse', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'get_npc', { npcId: 5 }, undefined, false);
    harvestRetrievals(ledger, 'get_npc', { npcId: 5 }, JSON.stringify({ id: 5 }), true);
    expect(ledger.get('npc', 5)?.ok).toBe(true);
    harvestRetrievals(ledger, 'get_npc', { npcId: 5 }, undefined, false);
    expect(ledger.get('npc', 5)?.ok).toBe(true);
  });

  it('ignores non-JSON and malformed payloads without throwing', () => {
    const ledger = new RetrievalLedger();
    expect(() => harvestRetrievals(ledger, 'lookup_rule', {}, 'not json')).not.toThrow();
    expect(ledger.size).toBe(0);
  });

  it('rejects non-positive and non-integer ids outright', () => {
    const ledger = new RetrievalLedger();
    ledger.record('npc', 0, 't');
    ledger.record('npc', -3, 't');
    ledger.record('npc', 1.5, 't');
    expect(ledger.size).toBe(0);
  });
});

describe('#577 adversarial — fabricated rules', () => {
  it('flags a rules ruling whose cited rule id was never retrieved', () => {
    const ledger = new RetrievalLedger();
    const raw = `A fireball deals 12d6 in this edition.\n${block({
      claims: [{ text: 'A fireball deals 12d6.', kind: 'rule', cites: [{ type: 'rule', id: 9999 }] }],
    })}`;
    const verdict = verdictFor(raw, ledger);
    expect(verdict.status).toBe('unverified');
    expect(verdict.unsupportedCount).toBe(1);
    expect(verdict.claims[0].reason).toBe('not_retrieved');
    expect(verdict.claims[0].citations[0]).toMatchObject({ type: 'rule', id: 9999, status: 'unsupported' });
  });

  it('flags a confident rules ruling that cites nothing at all', () => {
    const raw = `Rule of thumb: everyone gets advantage underwater.\n${block({
      claims: [{ text: 'Everyone gets advantage underwater.', kind: 'rule', cites: [] }],
    })}`;
    const verdict = verdictFor(raw, new RetrievalLedger());
    expect(verdict.claims[0].reason).toBe('no_citation');
    expect(verdict.status).toBe('unverified');
  });

  it('accepts a rules ruling whose cited entry the compendium actually returned this turn', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'lookup_rule', { query: 'fireball' }, JSON.stringify([{ id: 501, name: 'Fireball' }]));
    const raw = `The blast washes over the room — 8d6 fire.\n${block({
      claims: [{ text: 'Fireball deals 8d6 fire damage.', kind: 'rule', cites: [{ type: 'rule', id: 501 }] }],
    })}`;
    const verdict = verdictFor(raw, ledger);
    expect(verdict.status).toBe('clean');
    expect(verdict.claims[0].citations[0]).toMatchObject({
      status: 'supported',
      retrievedBy: 'lookup_rule',
      href: `/c/${CAMPAIGN}/compendium/501`,
    });
  });

  it('rejects a citation whose retrieval errored — an attempted read is not a read', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'get_rule_entry', { entryId: 777 }, '{"error":{"status":404}}', false);
    const raw = `It works how I said.\n${block({
      claims: [{ text: 'Grappling ends concentration.', kind: 'rule', cites: [{ type: 'rule', id: 777 }] }],
    })}`;
    expect(verdictFor(raw, ledger).claims[0].reason).toBe('retrieval_failed');
  });
});

describe('#577 adversarial — fabricated NPC facts, inventory, and quest state', () => {
  it('flags an invented NPC fact citing an NPC id that was never read', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'get_campaign_summary', { campaignId: CAMPAIGN }, JSON.stringify({ npcs: [{ id: 11 }] }));
    const raw = `Kaeda's brother runs the docks.\n${block({
      claims: [{ text: 'Kaeda has a brother who runs the docks.', kind: 'canon', cites: [{ type: 'npc', id: 88 }] }],
    })}`;
    const verdict = verdictFor(raw, ledger);
    expect(verdict.claims[0].reason).toBe('not_retrieved');
  });

  it('flags an inventory claim about an item the party was never shown to hold', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'list_inventory', { campaignId: CAMPAIGN }, JSON.stringify([{ id: 3, name: 'Rope' }]));
    const raw = `You already have the Sunstone, of course.\n${block({
      claims: [{ text: 'The party already holds the Sunstone.', kind: 'canon', cites: [{ type: 'item', id: 61 }] }],
    })}`;
    expect(verdictFor(raw, ledger).claims[0].reason).toBe('not_retrieved');
  });

  it('flags a quest-state claim about a quest id from no read this turn', () => {
    const raw = `That contract is settled.\n${block({
      claims: [{ text: 'Quest 4 is complete.', kind: 'canon', cites: [{ type: 'quest', id: 4 }] }],
    })}`;
    expect(verdictFor(raw, new RetrievalLedger()).claims[0].reason).toBe('not_retrieved');
  });

  it('flags an id borrowed from another campaign — it never reached this turn’s ledger', () => {
    // The tool layer refuses cross-campaign reads, so a cross-campaign id can never be
    // harvested; from the validator's side that is indistinguishable from fabrication, and
    // both are correctly unsupported.
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'list_npcs', { campaignId: CAMPAIGN }, JSON.stringify([{ id: 11 }]));
    const raw = `The Baroness of the other realm sends word.\n${block({
      claims: [{ text: 'The Baroness is allied with the party.', kind: 'canon', cites: [{ type: 'npc', id: 4242 }] }],
    })}`;
    expect(verdictFor(raw, ledger).claims[0].status).toBe('unsupported');
  });

  it('accepts a canon claim about an NPC the campaign summary actually supplied', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(
      ledger,
      'get_campaign_summary',
      { campaignId: CAMPAIGN },
      JSON.stringify({ npcs: [{ id: 11, name: 'Kaeda' }] }),
    );
    const raw = `Kaeda leans across the bar.\n${block({
      claims: [{ text: 'Kaeda tends the bar at the Rusted Kettle.', kind: 'canon', cites: [{ type: 'npc', id: 11 }] }],
    })}`;
    const verdict = verdictFor(raw, ledger);
    expect(verdict.status).toBe('clean');
    expect(verdict.claims[0].citations[0].href).toBe(`/c/${CAMPAIGN}/npcs/11`);
  });

  it('rejects a malformed or unknown citation shape as loudly as a missing one', () => {
    const raw = `x\n${block({
      claims: [
        { text: 'a', kind: 'canon', cites: [{ type: 'spellbook', id: 3 }] },
        { text: 'b', kind: 'canon', cites: [{ type: 'npc', id: 'twelve' }] },
      ],
    })}`;
    const verdict = verdictFor(raw, new RetrievalLedger());
    expect(verdict.claims[0].reason).toBe('unknown_source_type');
    expect(verdict.claims[1].reason).toBe('malformed_id');
    expect(verdict.unsupportedCount).toBe(2);
  });

  it('marks a claim unsupported when ANY of its citations fails', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'get_npc', { npcId: 11 }, JSON.stringify({ id: 11 }));
    const raw = `x\n${block({
      claims: [
        {
          text: 'Kaeda and Doran both swore the oath.',
          kind: 'canon',
          cites: [{ type: 'npc', id: 11 }, { type: 'npc', id: 12 }],
        },
      ],
    })}`;
    const verdict = verdictFor(raw, ledger);
    expect(verdict.claims[0].status).toBe('unsupported');
    expect(verdict.claims[0].citations.map((c) => c.status)).toEqual(['supported', 'unsupported']);
  });
});

describe('#577 adversarial — false approval / applied-canon claims', () => {
  const proposalOnly: AppliedToolSummary[] = [{ name: 'upsert_npc', isError: false, proposed: true }];

  it('flags "the DM approved it" when nothing was applied this turn', () => {
    const verdict = verdictFor('The DM has approved this, so the guild now backs you.', new RetrievalLedger(), proposalOnly);
    expect(verdict.status).toBe('unverified');
    expect(verdict.claims.some((c) => c.reason === 'false_application_claim')).toBe(true);
  });

  it('flags "I have added that to the campaign" when the write was only proposed', () => {
    const found = detectUnsupportedApplicationClaims("I've added her to the campaign as your patron.", proposalOnly);
    expect(found.length).toBeGreaterThan(0);
  });

  it('flags "this is now canon" and "no DM approval is needed"', () => {
    expect(detectUnsupportedApplicationClaims('That is now canon.', [])).toHaveLength(1);
    expect(detectUnsupportedApplicationClaims('No DM approval is needed for this.', [])).toHaveLength(1);
  });

  it('catches the typographic apostrophe models actually emit, not just ASCII', () => {
    expect(detectUnsupportedApplicationClaims('I’ve added her to the campaign.', [])).toHaveLength(1);
    expect(detectUnsupportedApplicationClaims('That’s now canon.', [])).toHaveLength(1);
  });

  it('does not treat a pending DM confirmation as an applied write', () => {
    const pending: AppliedToolSummary[] = [
      { name: 'award_xp', isError: false, proposed: false, pendingConfirmation: true },
    ];
    expect(hasAppliedWrite(pending)).toBe(false);
    expect(detectUnsupportedApplicationClaims('That has been added to the campaign.', pending)).toHaveLength(1);
  });

  it('does not treat an errored write as an applied write', () => {
    expect(hasAppliedWrite([{ name: 'award_xp', isError: true, proposed: false }])).toBe(false);
  });

  it('stays quiet when a real direct live-play write did land', () => {
    const applied: AppliedToolSummary[] = [{ name: 'update_character_hp', isError: false, proposed: false }];
    expect(detectUnsupportedApplicationClaims('That has been added to the campaign.', applied)).toHaveLength(0);
  });

  it('leaves ordinary narration alone', () => {
    expect(
      detectUnsupportedApplicationClaims('The innkeeper approves of your manners and pours another.', []),
    ).toHaveLength(0);
  });
});

describe('#577 — creative narration is deliberately NOT gated', () => {
  it('passes an uncited claim the model declared as invention', () => {
    const raw = `Rain hammers the shutters.\n${block({
      claims: [{ text: 'Rain hammers the shutters.', kind: 'narration', cites: [] }],
    })}`;
    const verdict = verdictFor(raw, new RetrievalLedger());
    expect(verdict.status).toBe('clean');
    expect(verdict.claims[0].status).toBe('supported');
  });

  it('produces no claims at all for a pure-narration turn with an empty block', () => {
    const verdict = verdictFor(`The corridor bends north.\n${block({ claims: [] })}`, new RetrievalLedger());
    expect(verdict.claims).toHaveLength(0);
    expect(verdict.status).toBe('clean');
  });

  it('reports a malformed block as one unsupported claim carrying the narration head', () => {
    const raw = `You open the door.\n${GROUNDING_BLOCK_START}\n{oops\n${GROUNDING_BLOCK_END}`;
    const verdict = verdictFor(raw, new RetrievalLedger());
    expect(verdict.status).toBe('unverified');
    expect(verdict.claims[0].reason).toBe('block_malformed');
    expect(verdict.claims[0].text).toBe('You open the door.');
  });
});

describe('#577 — provenance and evidence links', () => {
  it('carries the provider name and served model on the verdict', () => {
    const verdict = verdictFor(`x\n${block({ claims: [{ text: 'a', kind: 'canon', cites: [] }] })}`, new RetrievalLedger());
    expect(verdict.provider).toBe('mock');
    expect(verdict.model).toBe('mock-model-1');
  });

  it('never leaks anything beyond the provider name and model id', () => {
    const verdict = verdictFor(`x\n${block({ claims: [{ text: 'a', kind: 'canon', cites: [] }] })}`, new RetrievalLedger());
    const serialized = JSON.stringify(verdict);
    for (const secret of ['apiKey', 'api_key', 'Authorization', 'Bearer', 'baseUrl', 'sk-']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('builds a campaign-scoped deep link for every source type it accepts', () => {
    expect(citationHref(3, 'rule', 5)).toBe('/c/3/compendium/5');
    expect(citationHref(3, 'quest', 5)).toBe('/c/3/quests/5');
    expect(citationHref(3, 'location', 5)).toBe('/c/3/locations/5');
    expect(citationHref(3, 'encounter', 5)).toBe('/c/3/encounters/5');
    expect(citationHref(3, 'nonsense', 5)).toBeUndefined();
  });

  it('exposes the turn’s retrievals as the evidence list', () => {
    const ledger = new RetrievalLedger();
    harvestRetrievals(ledger, 'lookup_rule', {}, JSON.stringify([{ id: 501 }]));
    const verdict = verdictFor(`x\n${block({ claims: [] })}`, ledger);
    expect(verdict.retrievals).toEqual([{ type: 'rule', id: 501, tool: 'lookup_rule', ok: true }]);
  });
});

describe('#577 — the citation block never reaches the table mid-stream', () => {
  function run(deltas: string[]): string {
    const filter = new GroundingDeltaFilter();
    return deltas.map((d) => filter.push(d)).join('') + filter.flush();
  }

  it('passes plain narration straight through', () => {
    expect(run(['The ', 'door ', 'creaks.'])).toBe('The door creaks.');
  });

  it('suppresses everything from the fence onward, even split across deltas', () => {
    expect(run(['Narration.', '\n[[GRO', 'UNDING]]', '{"claims":[]}', '[[/GROUNDING]]'])).toBe('Narration.\n');
  });

  it('suppresses the fence when it arrives one character at a time', () => {
    const deltas = 'Hi.[[GROUNDING]]{"claims":[]}[[/GROUNDING]]'.split('');
    expect(run(deltas)).toBe('Hi.');
  });

  it('releases a held-back tail that never became a fence', () => {
    expect(run(['The chest is marked [[', 'not a fence.'])).toBe('The chest is marked [[not a fence.');
  });

  it('flushes a dangling partial fence at end of stream rather than truncating', () => {
    expect(run(['Ends with ['])).toBe('Ends with [');
  });
});

describe('#577 — unverified claims route to the stuck ladder', () => {
  it('classifies a completed turn with unsupported claims as stuck', () => {
    expect(
      classifyStuck({ stopReason: 'complete', narration: 'text', prevNarration: null, unsupportedClaims: 1 }),
    ).toBe('unsupported_claim');
  });

  it('leaves a completed turn with no unsupported claims healthy', () => {
    expect(
      classifyStuck({ stopReason: 'complete', narration: 'text', prevNarration: null, unsupportedClaims: 0 }),
    ).toBeNull();
  });

  it('keeps hard stops outranking an unverified claim (more actionable diagnosis)', () => {
    expect(
      classifyStuck({ stopReason: 'tool_error', narration: 'text', prevNarration: null, unsupportedClaims: 3 }),
    ).toBe('tool_error');
    expect(
      classifyStuck({ stopReason: 'budget_exhausted', narration: '', prevNarration: null, unsupportedClaims: 3 }),
    ).toBe('budget_exhausted');
  });

  it('does not treat a deliberate cancel/freeze as an unverified-claim stuck condition', () => {
    expect(
      classifyStuck({ stopReason: 'cancelled', narration: 'text', prevNarration: null, unsupportedClaims: 2 }),
    ).toBeNull();
    expect(
      classifyStuck({ stopReason: 'frozen', narration: 'text', prevNarration: null, unsupportedClaims: 2 }),
    ).toBeNull();
  });

  it('stays backwards-compatible when no grounding count is supplied', () => {
    expect(classifyStuck({ stopReason: 'complete', narration: 'text', prevNarration: null })).toBeNull();
  });
});

describe('#577 — the prompt contract states the split and the enforcement', () => {
  it('names both halves of the split and warns that citations are server-checked', () => {
    expect(GROUNDING_CITATION_CONTRACT).toContain('CREATIVE NARRATION');
    expect(GROUNDING_CITATION_CONTRACT).toContain('FACTUAL CLAIMS');
    expect(GROUNDING_CITATION_CONTRACT).toContain(GROUNDING_BLOCK_START);
    expect(GROUNDING_CITATION_CONTRACT).toContain('the server checks every one of them');
    expect(GROUNDING_CITATION_CONTRACT).toContain('PROPOSALS');
  });
});
