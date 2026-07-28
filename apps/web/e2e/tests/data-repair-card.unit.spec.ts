import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

test('data repair card makes preview tokens mandatory and exposes scan, undo and support download', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/features/admin/DataRepairCard.tsx'), 'utf8');
  expect(source).toContain('previewToken:current.previewToken');
  expect(source).toContain('Apply previewed repair');
  expect(source).toContain('Run integrity scan');
  expect(source).toContain('Undo safely');
  expect(source).toContain('support-bundle');
  expect(source).toContain('setPreview({})');
  expect(source).toContain('clearPreview(finding.id)');
});
