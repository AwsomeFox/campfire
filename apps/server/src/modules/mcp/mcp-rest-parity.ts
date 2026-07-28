/**
 * Issue #683 — REST ↔ MCP parity manifest for domains that previously lacked MCP tools.
 * CI (mcp-rest-parity.spec.ts) asserts every `mcpTool` is registered on the server
 * catalog. Entries with `mcpTool: null` are intentionally unsupported over MCP (binary
 * multipart upload); agents must use the documented REST route instead.
 */
export interface McpRestParityEntry {
  /** Human-readable REST route (method + path pattern). */
  rest: string;
  /** Matching MCP tool name, or null when MCP cannot carry the operation. */
  mcpTool: string | null;
  /** Why MCP omits the route (required when mcpTool is null). */
  note?: string;
}

export const MCP_REST_PARITY_ISSUE_683: readonly McpRestParityEntry[] = [
  // invites
  { rest: 'GET /campaigns/:campaignId/invites', mcpTool: 'list_invites' },
  { rest: 'POST /campaigns/:campaignId/invites', mcpTool: 'create_invite' },
  { rest: 'DELETE /campaigns/:campaignId/invites/:inviteId', mcpTool: 'revoke_invite' },
  { rest: 'DELETE /campaigns/:campaignId/invites', mcpTool: 'revoke_all_invites' },
  { rest: 'PUT /campaigns/:campaignId/invites/policy', mcpTool: 'set_invite_policy' },
  { rest: 'GET /invites/:code', mcpTool: 'preview_invite' },
  { rest: 'POST /invites/:code/join', mcpTool: 'join_invite' },
  // notifications (user-scoped)
  { rest: 'GET /notifications', mcpTool: 'list_notifications' },
  { rest: 'GET /notifications/unread-count', mcpTool: 'get_unread_notification_count' },
  { rest: 'GET /notifications/preferences', mcpTool: 'get_notification_preferences' },
  { rest: 'PUT /notifications/preferences/:campaignId', mcpTool: 'set_notification_preferences' },
  { rest: 'POST /notifications/:id/read', mcpTool: 'mark_notification_read' },
  { rest: 'POST /notifications/:id/unread', mcpTool: 'mark_notification_unread' },
  { rest: 'POST /notifications/mark-read', mcpTool: 'mark_notifications_read' },
  { rest: 'POST /notifications/mark-unread', mcpTool: 'mark_notifications_unread' },
  { rest: 'POST /notifications/read-all', mcpTool: 'mark_all_notifications_read' },
  // proposals — revision / batch
  { rest: 'PATCH /proposals/:id', mcpTool: 'revise_proposal' },
  { rest: 'POST /proposals/batch/approve', mcpTool: 'batch_approve_proposals' },
  { rest: 'POST /proposals/batch/reject', mcpTool: 'batch_reject_proposals' },
  // trash / restore
  { rest: 'GET /campaigns/trash', mcpTool: 'list_trashed_campaigns' },
  { rest: 'POST /campaigns/:id/restore', mcpTool: 'restore_campaign' },
  { rest: 'GET /campaigns/:id/trash', mcpTool: 'list_campaign_trash' },
  { rest: 'POST /sessions/:id/restore', mcpTool: 'restore_session' },
  { rest: 'POST /characters/:id/restore', mcpTool: 'restore_character' },
  { rest: 'POST /quests/:id/restore', mcpTool: 'restore_quest' },
  { rest: 'POST /npcs/:id/restore', mcpTool: 'restore_npc' },
  { rest: 'POST /locations/:id/restore', mcpTool: 'restore_location' },
  { rest: 'POST /notes/:id/restore', mcpTool: 'restore_note' },
  // encounters
  { rest: 'POST /campaigns/:campaignId/roll/action', mcpTool: 'roll_action_dice' },
  { rest: 'POST /encounters/:id/reopen', mcpTool: 'reopen_encounter' },
  // campaign library monsters (issue #425)
  { rest: 'GET /campaigns/:campaignId/library/monsters', mcpTool: 'list_campaign_library_monsters' },
  { rest: 'POST /campaigns/:campaignId/library/monsters', mcpTool: 'create_campaign_library_monster' },
  { rest: 'PATCH /library/monsters/:id', mcpTool: 'update_campaign_library_monster' },
  { rest: 'DELETE /library/monsters/:id', mcpTool: 'delete_campaign_library_monster' },
  { rest: 'POST /campaigns/:campaignId/library/monsters/:id/clone', mcpTool: 'clone_campaign_library_monster' },
  // spell slots
  { rest: 'POST /characters/:id/spell-slots', mcpTool: 'adjust_spell_slots' },
  // attachments — metadata reads already exist; manage + binary gap
  { rest: 'POST /campaigns/:campaignId/attachments', mcpTool: null, note: 'Binary multipart upload — use REST POST /campaigns/:campaignId/attachments (field file + kind).' },
  { rest: 'GET /attachments/:id/file', mcpTool: null, note: 'Binary file stream — use REST GET /attachments/:id/file.' },
  { rest: 'POST /attachments/:id/reveal', mcpTool: 'reveal_attachment' },
  { rest: 'POST /attachments/:id/hide', mcpTool: 'hide_attachment' },
  { rest: 'DELETE /attachments/:id', mcpTool: 'delete_attachment' },
  // inbox sweep (issue #1645) — same InboxSweepService.sweep() orchestration as the REST route
  { rest: 'POST /campaigns/:id/inbox/sweep', mcpTool: 'sweep_inbox' },
] as const;

/** Tool names introduced for issue #683 (subset used by e2e smoke tests). */
export const ISSUE_683_MCP_TOOLS = MCP_REST_PARITY_ISSUE_683.flatMap((e) => (e.mcpTool ? [e.mcpTool] : []));
