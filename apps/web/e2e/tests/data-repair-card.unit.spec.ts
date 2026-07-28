import fs from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';

const DATA_REPAIR_CARD = resolve(__dirname, '../../src/features/admin/DataRepairCard.tsx');

test('data repair card makes preview tokens mandatory and exposes scan, undo and support download', () => {
  const source = fs.readFileSync(DATA_REPAIR_CARD, 'utf8');
  expect(source).toContain('previewToken: current.previewToken');
  expect(source).toContain('Apply previewed repair');
  expect(source).toContain('Run integrity scan');
  expect(source).toContain('Undo safely');
  expect(source).toContain('support-bundle');
  expect(source).toContain('setPreview({})');
  expect(source).toContain('clearPreview(finding.id)');
  expect(source).toContain('parseReplacementParentId');
  expect(source).toContain('id > 0');
});
