import { expect, test } from '@playwright/test';
import {
  INVITE_COPY_FAILURE,
  INVITE_COPY_SUCCESS,
  INVITE_ROLES,
  inviteLinkFieldLabel,
  inviteRoleOptions,
} from '../../src/features/admin/inviteRoleOptions';

/**
 * Issue #516 — invite form accessible names.
 *
 * The invite card UI is thin wiring; these tests pin the vocabulary the role
 * selector and generated link fields expose to assistive tech.
 */

test.describe('invite role options (issue #516)', () => {
  test('covers player and viewer in a stable order', () => {
    expect(INVITE_ROLES).toEqual(['player', 'viewer']);
    expect(inviteRoleOptions().map((o) => o.role)).toEqual(['player', 'viewer']);
  });

  test('every option includes concise consequence text beyond the short label', () => {
    for (const opt of inviteRoleOptions()) {
      expect(opt.description.length).toBeGreaterThan(opt.label.length);
      expect(opt.description).toContain('—');
    }
  });
});

test.describe('invite link field labels (issue #516)', () => {
  test('names the read-only purpose for each role', () => {
    expect(inviteLinkFieldLabel('player')).toMatch(/player invite link, read-only/i);
    expect(inviteLinkFieldLabel('viewer')).toMatch(/viewer invite link, read-only/i);
  });
});

test.describe('invite copy announcements (issue #516)', () => {
  test('uses spoken success and failure messages', () => {
    expect(INVITE_COPY_SUCCESS).toMatch(/copied/i);
    expect(INVITE_COPY_FAILURE).toMatch(/copy failed/i);
  });
});
