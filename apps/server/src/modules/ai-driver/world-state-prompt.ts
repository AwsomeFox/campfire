/**
 * #1048: format player-scoped MCP reads into system-prompt sections.
 * Pure helpers so unit tests cover the omit/strip contracts without Nest/DB.
 */

/** True when a tool result is missing, blank, or the JSON empty-array marker `[]`. */
export function isEmptyToolPayload(text: string | null | undefined): boolean {
  if (text == null) return true;
  const trimmed = text.trim();
  return trimmed === '' || trimmed === '[]';
}

/**
 * Calendar rows always exist (unset defaults include createdAt/updatedAt = now).
 * Only inject when there is real in-world content; strip row metadata timestamps.
 */
export function formatCalendarForPrompt(text: string | null | undefined): string | null {
  if (isEmptyToolPayload(text)) return null;
  try {
    const parsed = JSON.parse(text!.trim()) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const currentDate = typeof parsed.currentDate === 'string' ? parsed.currentDate.trim() : '';
    const note = typeof parsed.note === 'string' ? parsed.note.trim() : '';
    if (!currentDate && !note) return null;
    const payload: Record<string, unknown> = { campaignId: parsed.campaignId };
    if (currentDate) payload.currentDate = currentDate;
    if (note) payload.note = note;
    return JSON.stringify(payload);
  } catch {
    // Non-JSON tool text: keep as-is if non-empty.
    return text!.trim() || null;
  }
}

/** Omit empty / `[]` list payloads (running encounters, party). */
export function formatListForPrompt(text: string | null | undefined): string | null {
  if (isEmptyToolPayload(text)) return null;
  return text!.trim();
}

/**
 * Pull current location + campaign danger level out of get_campaign_summary JSON
 * so the prompt has a dedicated environment section without an extra tool call.
 * dmSecret is never included (summary is already role-redacted).
 */
export function formatLocationEnvironmentFromSummary(summaryText: string | null | undefined): string | null {
  if (isEmptyToolPayload(summaryText)) return null;
  try {
    const parsed = JSON.parse(summaryText!.trim()) as {
      currentLocation?: Record<string, unknown> | null;
      campaign?: { dangerLevel?: unknown } | null;
    };
    const loc = parsed.currentLocation;
    const dangerLevel = parsed.campaign?.dangerLevel;
    if (!loc || typeof loc !== 'object') {
      // No known location — still surface non-default danger as environmental context.
      if (typeof dangerLevel === 'string' && dangerLevel && dangerLevel !== 'low') {
        return JSON.stringify({ dangerLevel });
      }
      return null;
    }
    const payload: Record<string, unknown> = {
      location: {
        id: loc.id,
        name: loc.name,
        kind: loc.kind,
        status: loc.status,
        body: loc.body,
      },
    };
    if (typeof dangerLevel === 'string' && dangerLevel) payload.dangerLevel = dangerLevel;
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}
