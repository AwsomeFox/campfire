/**
 * One named, player-safe display window for the DM cockpit (issue #762).
 *
 * The opener deliberately never puts a capability URL in a cross-window
 * message. It opens an innocuous blank window in the click stack, then only
 * navigates that owned window once the server has minted the cast capability.
 */
export const CAST_WINDOW_NAME = 'campfire-player-display';
export const CAST_DISPLAY_CHANNEL = 'campfire-player-display-status-v1';

export type CastDisplayStatus =
  | { type: 'ready'; campaignId: number; encounterId: number | null; encounterName: string | null }
  | { type: 'closed'; campaignId: number };

export type CastWindowState = 'idle' | 'opening' | 'popup-blocked' | 'window-closed' | 'ready';

/** Accept only the non-secret status protocol for this campaign. This keeps a
 * random same-origin message from making the cockpit claim a display is ready. */
export function isCastDisplayStatusForCampaign(value: unknown, campaignId: number): value is CastDisplayStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<CastDisplayStatus>;
  if (status.campaignId !== campaignId) return false;
  if (status.type === 'closed') return true;
  return status.type === 'ready'
    && (typeof status.encounterId === 'number' || status.encounterId === null)
    && (typeof status.encounterName === 'string' || status.encounterName === null);
}

export function openCastWindow(open: Window['open'] = window.open.bind(window)): Window | null {
  // Must stay synchronous with the gesture that called this function. Browsers
  // otherwise treat it as a popup, even if the capability request began in it.
  return open('', CAST_WINDOW_NAME, 'popup,width=1280,height=720,noopener=false');
}

export function focusCastWindow(target: Window | null | undefined): boolean {
  if (!target || target.closed) return false;
  try {
    target.focus();
    return true;
  } catch {
    return false;
  }
}

/** Navigation happens after the server response, but stays inside the window
 * opened in the click stack. `replace` avoids a blank page in Back history. */
export function navigateCastWindow(target: Window, url: string): boolean {
  try {
    if (target.closed) return false;
    target.location.replace(url);
    return true;
  } catch {
    return false;
  }
}

export function displayStatusLabel(
  state: CastWindowState,
  followed: { encounterId: number | null; encounterName: string | null; isCurrentEncounter: boolean } | null,
): string {
  switch (state) {
    case 'opening':
      return 'Opening the player display…';
    case 'popup-blocked':
      return 'Popup blocked — allow popups for Campfire, then open the display again.';
    case 'window-closed':
      return 'Display window was closed. Open display to reconnect.';
    case 'ready':
      if (!followed?.encounterId) return 'Display connected · no running encounter';
      if (followed.isCurrentEncounter) return `Display connected · following ${followed.encounterName ?? `encounter #${followed.encounterId}`}`;
      return `Display connected · following another encounter (${followed.encounterName ?? `#${followed.encounterId}`})`;
    default:
      return 'Display not connected.';
  }
}
