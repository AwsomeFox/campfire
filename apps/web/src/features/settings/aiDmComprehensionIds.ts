/**
 * DOM ids for the AI DM Comprehension profile controls (issue #874).
 *
 * Same tiny-module pattern as `aiDmStyleIds` (#1049): deep-link / a11y tests can import the
 * constants without pulling in the AiDmCard React tree, and the string literals have one
 * source of truth rather than being retyped in the JSX and again in a spec.
 */

/** Deep-link hash for the Comprehension profile section. Registered in `settingsNavigation`. */
export const AI_DM_COMPREHENSION_SECTION_ID = 'ai-dm-comprehension';

/** Per-axis control id — distinct from the section anchor so the two never collide. */
export function aiDmComprehensionSelectId(axis: string): string {
  return `ai-dm-comprehension-${axis}`;
}
