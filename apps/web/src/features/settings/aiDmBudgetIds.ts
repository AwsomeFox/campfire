/**
 * DOM ids for the AI DM Budget & usage controls (issue #751).
 *
 * Kept in a tiny dependency-free module so deep-link / a11y tests can import the
 * constants without pulling in the AiDmCard React tree, and so the string
 * literals have a single source of truth.
 */

/** Deep-link hash for the Budget & usage section (onboarding checklist / gate CTAs). */
export const AI_DM_BUDGET_SECTION_ID = 'ai-dm-budget';

/** Distinct control id for the token-budget input — must not collide with the section anchor. */
export const AI_DM_BUDGET_INPUT_ID = 'ai-dm-budget-input';
