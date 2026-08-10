import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../src');
const handouts = readFileSync(resolve(ROOT, 'features/dashboard/HandoutsCard.tsx'), 'utf8');
const upload = readFileSync(resolve(ROOT, 'components/ImageUpload.tsx'), 'utf8');

test.describe('attachment metadata handouts (#735)', () => {
  test('uploads optional provenance fields as multipart form data', () => {
    expect(upload).toContain('AttachmentUploadMetadata');
    expect(upload).toContain('Object.entries(metadata)');
    expect(upload).toContain("form.append('kind', kind)");
  });

  test('renders meaningful visual and PDF labels plus provenance', () => {
    expect(handouts).toContain('meta.altText || meta.title || a.filename');
    expect(handouts).toContain('meta.caption');
    expect(handouts).toContain('meta.attribution || meta.creator');
    expect(handouts).toContain('meta.license');
    expect(handouts).toContain('meta.sourceUrl');
    // The name is the link's ACCESSIBLE name now, not its visible text. Repeating the
    // filename in all three visible labels ("View fog-security-map.png", "Download …",
    // "Print …") wrapped each link over four lines in the handouts card; the aria-label
    // keeps the meaningful name #735 asks for without the crowding.
    expect(handouts).toContain('aria-label={`View ${meta.title || a.filename}`}');
    expect(handouts).toContain('aria-label={`Download ${meta.title || a.filename}`}');
    expect(handouts).toContain('aria-label={`Print ${meta.title || a.filename}`}');
  });

  /**
   * The metadata inputs must come from the design system, not hand-rolled classes.
   *
   * They were bare `<input>`s with `text-slate-900` and no background or border — on this
   * app's dark surfaces that is eight labels above eight invisible boxes, where the typed
   * value is invisible too. It renders in two places (the upload disclosure and the Edit
   * details dialog), so both were affected.
   *
   * Asserted as "routes through TextInput" rather than by listing forbidden colours: the
   * point is that this control does not get its own styling opinion.
   */
  test('handout metadata fields use the shared input, not hand-rolled light-theme classes', () => {
    expect(handouts).toMatch(/<TextInput[^>]*aria-label=\{label\}/s);
    // Matched on an APPLIED className, not on the file text: the comment above the
    // component names the old class deliberately, and a bare `not.toContain` would flag
    // the explanation as the defect.
    expect(handouts).not.toMatch(/className="[^"]*text-slate-900/);
  });

  test('keeps correction controls DM-only and sends optimistic updatedAt', () => {
    expect(handouts).toContain('canDmWrite && (');
    expect(handouts).toContain('Edit details');
    expect(handouts).toContain('updatedAt: editing.updatedAt');
    expect(handouts).toContain('/metadata`');
    expect(handouts).toContain('changed elsewhere');
    expect(handouts).toContain('list?.find((a) => a.id === editing.id)');
    expect(handouts).toContain('setEditing(fresh)');
    expect(handouts).toContain('Handout details (optional)');
  });
});
