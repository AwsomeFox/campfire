#!/usr/bin/env node
import assert from 'node:assert';
import { extractJsxTextNodes } from './check-i18n-catalog.mjs';

// Fixture 1: Plain hardcoded JSX text node -> MUST flag
const hardcodedFixture = '<div><button>Save Changes</button></div>';
const hardcodedNodes = extractJsxTextNodes(hardcodedFixture);
assert.strictEqual(hardcodedNodes.length, 1);
assert.strictEqual(hardcodedNodes[0], 'Save Changes');

// Fixture 2: Translated t('key') call -> MUST NOT flag
const translatedFixture = '<div>{t("common.save", "Save Changes")}</div>';
const translatedNodes = extractJsxTextNodes(translatedFixture);
assert.strictEqual(translatedNodes.length, 0);

// Fixture 3: data-testid and className attributes -> MUST NOT flag
const attrFixture = '<div data-testid="save-btn" className="btn-primary"><span>12</span></div>';
const attrNodes = extractJsxTextNodes(attrFixture);
assert.strictEqual(attrNodes.length, 0);

// Fixture 4: Dice notation literal -> MUST NOT flag
const diceFixture = '<div><span>1d8+4</span><span>d20</span></div>';
const diceNodes = extractJsxTextNodes(diceFixture);
assert.strictEqual(diceNodes.length, 0);

console.log('check-i18n-catalog.spec: ok — all self-test fixtures passed');
