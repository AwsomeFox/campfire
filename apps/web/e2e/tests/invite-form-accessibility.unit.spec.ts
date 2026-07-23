import { expect, test } from '@playwright/test';
import {
  INVITE_COPY_FAILURE,
  INVITE_COPY_SUCCESS,
  INVITE_ROLE_OPTIONS,
  INVITE_ROLES,
  inviteCopyButtonLabel,
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
  test('covers player and viewer in a stable order from one source', () => {
    expect(INVITE_ROLE_OPTIONS.map((o) => o.role)).toEqual(['player', 'viewer']);
    expect(INVITE_ROLES).toEqual(INVITE_ROLE_OPTIONS.map((o) => o.role));
    expect(inviteRoleOptions()).toBe(INVITE_ROLE_OPTIONS);
  });

  test('every option includes concise consequence text beyond the short label', () => {
    for (const opt of inviteRoleOptions()) {
      expect(opt.description.length).toBeGreaterThan(opt.label.length);
      expect(opt.description).toContain('—');
    }
  });
});

test.describe('invite link field labels (issue #516)', () => {
  test('names the read-only purpose for each role and invite id', () => {
    expect(inviteLinkFieldLabel('player', 12)).toMatch(/player invite link 12, read-only/i);
    expect(inviteLinkFieldLabel('viewer', 34)).toMatch(/viewer invite link 34, read-only/i);
  });

  test('keeps same-role invites distinguishable by id', () => {
    expect(inviteLinkFieldLabel('player', 1)).not.toBe(inviteLinkFieldLabel('player', 2));
  });
});

test.describe('invite copy button labels (issue #516)', () => {
  test('names the invite by role and id without claiming it is read-only', () => {
    expect(inviteCopyButtonLabel('player', 12)).toMatch(/^Copy player invite link 12$/i);
    expect(inviteCopyButtonLabel('viewer', 34)).toMatch(/^Copy viewer invite link 34$/i);
    // The button is actionable — it must not sound "read-only" like the field.
    expect(inviteCopyButtonLabel('viewer', 34)).not.toMatch(/read-only/i);
  });

  test('keeps same-role invites distinguishable by id', () => {
    expect(inviteCopyButtonLabel('player', 1)).not.toBe(inviteCopyButtonLabel('player', 2));
  });
});

test.describe('invite copy announcements (issue #516)', () => {
  test('uses spoken success and failure messages', () => {
    expect(INVITE_COPY_SUCCESS).toMatch(/copied/i);
    expect(INVITE_COPY_FAILURE).toMatch(/copy failed/i);
  });
});
