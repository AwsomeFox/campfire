import {
  AI_DM_SEAT_INHERITED_FIELDS,
  AI_DM_SEAT_NON_INHERITED_FIELDS,
  AiDmSeat,
  AiDmSeatDefaults,
} from '@campfire/schema';

/**
 * Server-wide AI seat defaults (#1070).
 *
 * A multi-campaign DM reconfigured the AI seat from scratch every time: `defaultSeat` gave
 * mode `off`, budget `0`, instructions `''`, and only the PROVIDER inherited server-wide.
 *
 * The first describe below is the one that matters most. The allowlist is only a real
 * guarantee if it cannot be bypassed by inattention — a comment saying "never the credential"
 * is a comment, whereas a test that fails the moment someone adds an unclassified field is the
 * actual control. #1052 established that whoever owns the key owns the destination, because a
 * half-config borrowing another row's credential ships that credential wherever the borrowing
 * row points; carrying config BETWEEN campaigns is the same hazard from the other direction.
 */

/** Every field name on the seat config surface. */
const seatKeys = Object.keys(AiDmSeat.shape).sort();

describe('#1070 inheritance allowlist is exhaustive and enforced', () => {
  it('classifies EVERY seat field as either inherited or explicitly excluded', () => {
    // The load-bearing assertion. Add a field to AiDmSeat and this fails until someone decides,
    // in writing, whether it travels to a new campaign — which is exactly the moment to think
    // about it, rather than after it has been silently propagating for a release.
    const classified = [
      ...AI_DM_SEAT_INHERITED_FIELDS,
      ...Object.keys(AI_DM_SEAT_NON_INHERITED_FIELDS),
    ].sort();
    expect(classified).toEqual(seatKeys);
  });

  it('never classifies the same field twice', () => {
    for (const field of AI_DM_SEAT_INHERITED_FIELDS) {
      expect(AI_DM_SEAT_NON_INHERITED_FIELDS).not.toHaveProperty(field);
    }
  });

  it('records a REASON for every exclusion, not just a name', () => {
    // An exclusion list of bare names decays into "fields nobody got round to". A sentence per
    // entry is what makes a future reader able to tell a decision from an oversight.
    for (const [field, reason] of Object.entries(AI_DM_SEAT_NON_INHERITED_FIELDS)) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(15);
      expect(field.length).toBeGreaterThan(0);
    }
  });

  it('refuses to inherit anything credential-shaped, now or later', () => {
    // Today the seat carries no key material at all — provider credentials live on
    // `ai_provider_configs` and are decrypted only inside resolveEffectiveConfig. This keeps
    // that true BY CONSTRUCTION: if a credential-shaped field is ever added to the seat, this
    // fails whichever list it was put in, rather than quietly riding along to a new campaign.
    const credentialShaped = /apikey|api_key|secret|credential|cipher|encrypted|password/i;
    for (const field of seatKeys) {
      expect(field).not.toMatch(credentialShaped);
    }
    for (const field of AI_DM_SEAT_INHERITED_FIELDS) {
      expect(field).not.toMatch(credentialShaped);
    }
  });

  it('inherits only fields that a server default can actually supply', () => {
    // Every allowlisted field must exist on the defaults object, or "inheritance" would be
    // claiming to carry something with no source.
    const defaults = AiDmSeatDefaults.parse({});
    for (const field of AI_DM_SEAT_INHERITED_FIELDS) {
      expect(defaults).toHaveProperty(field);
    }
    expect(Object.keys(defaults).sort()).toEqual([...AI_DM_SEAT_INHERITED_FIELDS].sort());
  });

  it('excludes the two consent-to-spend fields, by name', () => {
    // Called out explicitly because they are the ones with a money consequence: inheriting
    // either would let a brand-new campaign start spending against a number nobody chose.
    expect(AI_DM_SEAT_NON_INHERITED_FIELDS).toHaveProperty('enabled');
    expect(AI_DM_SEAT_NON_INHERITED_FIELDS).toHaveProperty('proactiveSettings');
    expect([...AI_DM_SEAT_INHERITED_FIELDS]).not.toContain('enabled');
    expect([...AI_DM_SEAT_INHERITED_FIELDS]).not.toContain('proactiveSettings');
  });
});

describe('#1070 seat defaults shape', () => {
  it('falls back to the pre-#1070 seat values when an admin has set nothing', () => {
    // The shipped state must be indistinguishable from the old hardcoded defaults, so an
    // install that never touches this feature behaves exactly as before.
    expect(AiDmSeatDefaults.parse({})).toEqual({
      mode: 'off',
      instructions: '',
      tokenBudget: 0,
      actionQueueDepth: 8,
    });
  });

  it('degrades per-field on a partial or malformed stored value', () => {
    // A bad server default must not be able to break every campaign's seat read, so parsing
    // fills the gaps rather than throwing.
    expect(AiDmSeatDefaults.parse({ tokenBudget: 50_000 })).toEqual({
      mode: 'off',
      instructions: '',
      tokenBudget: 50_000,
      actionQueueDepth: 8,
    });
  });

  it("rejects values outside the seat's own limits", () => {
    expect(() => AiDmSeatDefaults.parse({ tokenBudget: -1 })).toThrow();
    expect(() => AiDmSeatDefaults.parse({ mode: 'sidekick' })).toThrow();
    expect(() => AiDmSeatDefaults.parse({ actionQueueDepth: 999 })).toThrow();
  });
});
