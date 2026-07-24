/**
 * Attachment publication states for the reserved→committed protocol (#728).
 * Keep these in a leaf module so campaigns/encounters/attachments can share
 * them without importing the Nest service implementation.
 */
export const ATTACHMENT_STATE_RESERVED = 'reserved';
export const ATTACHMENT_STATE_COMMITTED = 'committed';
