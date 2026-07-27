import * as schema from '@campfire/schema';

/**
 * Issue #588 — every booking write that takes `force` must report what it
 * overrode.
 *
 * The PR states this as a principle ("an override the caller cannot tell they
 * took is not an override"), and the branch then shipped `restore()` returning a
 * payload with nowhere to say so. That is the fourth instance of one shape on
 * this branch: a rule enforced at the sites under review and not at the sibling
 * nobody looked at. The notification fan-out got a path table for the same
 * reason, and that table is what surfaced the path nobody had reported.
 *
 * A comment would not have caught this one, so the rule is enforced here
 * instead. This spec DISCOVERS every request schema carrying a `force` flag by
 * reflection rather than reading a list, so adding `force` anywhere new fails
 * until someone classifies it — and classifying it as a booking override
 * requires naming a response schema that actually carries `conflicts`.
 */
describe('force-taking writes report what they overrode (#588)', () => {
  type ZodObjectish = { _def?: { typeName?: string }; shape?: Record<string, unknown> };

  const exported = schema as unknown as Record<string, unknown>;

  function shapeOf(name: string): Record<string, unknown> | undefined {
    const value = exported[name] as ZodObjectish | undefined;
    return value?._def?.typeName === 'ZodObject' ? value.shape : undefined;
  }

  /** Every exported Zod object schema whose shape has a `force` key. */
  function schemasWithForce(): string[] {
    return Object.keys(exported)
      .filter((name) => {
        const shape = shapeOf(name);
        return shape != null && Object.prototype.hasOwnProperty.call(shape, 'force');
      })
      .sort();
  }

  /**
   * The classification. A booking override must name a response schema; anything
   * else has to say why it is exempt.
   */
  const CLASSIFIED: Record<string, { responseSchema: string } | { exempt: string }> = {
    // Restore RE-ACQUIRES the room and DM its cancellation released.
    ScheduledSessionRestore: { responseSchema: 'ScheduledSessionRestored' },
    OccurrenceReschedule: { responseSchema: 'OccurrenceWriteResult' },
    OccurrenceReassign: { responseSchema: 'OccurrenceWriteResult' },
    ScheduleTemplateApply: { responseSchema: 'ScheduleTemplateApplyResult' },
    // NOT a booking override: `force` re-runs a scribe job that already
    // completed. It allocates no shared resource, so there is no conflict list a
    // caller could be denied.
    ScribeRunRequest: { exempt: 'scribe re-run — allocates no shared resource' },
  };

  it('classifies every schema that carries a `force` flag', () => {
    // The tripwire. Adding `force` to a new schema breaks this until someone
    // decides whether it is a booking override — which is the decision that was
    // skipped for `restore`.
    expect(schemasWithForce()).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it('every booking override names a response schema that carries `conflicts`', () => {
    for (const [request, entry] of Object.entries(CLASSIFIED)) {
      if (!('responseSchema' in entry)) continue;
      const shape = shapeOf(entry.responseSchema);
      expect({ request, response: entry.responseSchema, exists: shape != null }).toEqual({
        request,
        response: entry.responseSchema,
        exists: true,
      });
      expect({ request, reportsConflicts: Object.prototype.hasOwnProperty.call(shape!, 'conflicts') }).toEqual({
        request,
        reportsConflicts: true,
      });
    }
  });

  it('`conflicts` is REQUIRED on the restore response, not optional or defaulted', () => {
    // Required is what makes the guarantee structural rather than advisory: a
    // restore path that forgets to report does not typecheck, instead of
    // returning a payload the caller cannot interrogate.
    const withoutConflicts = {
      id: 1,
      campaignId: 1,
      scheduledAt: '2099-01-01T00:00:00.000Z',
      durationMinutes: 240,
      title: '',
      location: '',
      notes: '',
      status: 'scheduled',
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: '',
      sessionId: null,
      seriesId: null,
      occurrenceIndex: 0,
      timezone: '',
      localStart: '',
      venueId: null,
      roomId: null,
      assignedDmUserId: '',
      capacity: 0,
      eventId: '',
      seasonId: '',
      icsUid: '',
      icsSequence: 0,
      originalScheduledAt: null,
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
      rsvps: [],
    };
    expect(schema.ScheduledSessionRestored.safeParse(withoutConflicts).success).toBe(false);
    expect(schema.ScheduledSessionRestored.safeParse({ ...withoutConflicts, conflicts: [] }).success).toBe(true);
  });
});
