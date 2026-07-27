/**
 * DOM ids for the AI DM Table style controls (issue #1049).
 *
 * Same tiny-module pattern as `aiDmBudgetIds` (#751): deep-link / a11y tests can import the
 * constants without pulling in the AiDmCard React tree, and the string literals have one
 * source of truth rather than being retyped in the JSX and again in a spec.
 */

/** Deep-link hash for the Table style section. Registered in `settingsNavigation`. */
export const AI_DM_STYLE_SECTION_ID = 'ai-dm-style';

/** Per-axis control id — distinct from the section anchor so the two never collide. */
export function aiDmStyleSelectId(axis: string): string {
  return `ai-dm-style-${axis}`;
}
