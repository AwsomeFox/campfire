import { expect, test } from '@playwright/test';
import {
  initialDropzoneDrag,
  isDropzoneDragActive,
  reduceDropzoneDrag,
  type DropzoneDragSnapshot,
} from '../../src/components/imageUploadDragState';

/**
 * Issue #845: ImageUpload drag-active must stay stable when the pointer
 * crosses child element boundaries inside the dropzone.
 *
 * The pure model (containment-gated leave + boolean active) is what the
 * component renders; these specs pin the acceptance scenarios without a
 * brittle browser DnD harness:
 *   - enter keeps drag-active
 *   - leave into a child (stillInside) does NOT clear
 *   - leave outside clears even after nested child enter/leave pairs
 *   - drop / cancel / blur always reset
 */

function activeAfter(events: Parameters<typeof reduceDropzoneDrag>[1][]): boolean {
  let snap: DropzoneDragSnapshot = initialDropzoneDrag;
  for (const event of events) {
    snap = reduceDropzoneDrag(snap, event);
  }
  return isDropzoneDragActive(snap);
}

test.describe('image upload dropzone drag state (issue #845)', () => {
  test('idle is not drag-active', () => {
    expect(isDropzoneDragActive(initialDropzoneDrag)).toBe(false);
  });

  test('enter activates the drop affordance', () => {
    const snap = reduceDropzoneDrag(initialDropzoneDrag, { type: 'enter' });
    expect(snap.active).toBe(true);
    expect(isDropzoneDragActive(snap)).toBe(true);
  });

  test('crossing into a child (leave stillInside) does not flicker off', () => {
    // Browser sequence when moving from the dropzone into a label/img child:
    // dragleave(parent, relatedTarget=child) then dragenter(child, bubbles).
    // Containment must keep active; a naive leave→false would flicker.
    const sequence = [
      { type: 'enter' as const },
      { type: 'leave' as const, stillInside: true },
      { type: 'enter' as const },
    ];
    const samples: boolean[] = [];
    let snap: DropzoneDragSnapshot = initialDropzoneDrag;
    for (const event of sequence) {
      snap = reduceDropzoneDrag(snap, event);
      samples.push(isDropzoneDragActive(snap));
    }
    expect(samples).toEqual([true, true, true]);
    expect(snap.active).toBe(true);
  });

  test('repeated child-boundary crossings never drop to inactive', () => {
    let snap: DropzoneDragSnapshot = reduceDropzoneDrag(initialDropzoneDrag, { type: 'enter' });
    for (let i = 0; i < 5; i++) {
      snap = reduceDropzoneDrag(snap, { type: 'leave', stillInside: true });
      expect(isDropzoneDragActive(snap), `still active after child leave #${i}`).toBe(true);
      snap = reduceDropzoneDrag(snap, { type: 'enter' });
      expect(isDropzoneDragActive(snap), `still active after child enter #${i}`).toBe(true);
    }
  });

  test('leaving the dropzone entirely clears after nested child crossings', () => {
    // enter parent, enter child (bubbled), then leave outside — one outside
    // leave must clear even if nested enters inflated a former depth counter.
    expect(
      activeAfter([
        { type: 'enter' },
        { type: 'enter' },
        { type: 'leave', stillInside: false },
      ]),
    ).toBe(false);
  });

  test('child→padding→outside does not stick active (depth-drift regression)', () => {
    // Bugbot: leave-into-child skipped decrements while bubbled enters kept
    // incrementing; leaving the zone once left depth > 0 and the amber
    // highlight stuck until dragend/blur.
    expect(
      activeAfter([
        { type: 'enter' },
        { type: 'leave', stillInside: true },
        { type: 'enter' },
        { type: 'leave', stillInside: true }, // child → padding
        { type: 'enter' }, // re-enter on padding
        { type: 'leave', stillInside: false },
      ]),
    ).toBe(false);
  });

  test('a single leave outside after one enter clears', () => {
    expect(
      activeAfter([
        { type: 'enter' },
        { type: 'leave', stillInside: false },
      ]),
    ).toBe(false);
  });

  test('drop resets drag state', () => {
    const active = reduceDropzoneDrag(initialDropzoneDrag, { type: 'enter' });
    const afterDrop = reduceDropzoneDrag(active, { type: 'reset' });
    expect(afterDrop).toEqual(initialDropzoneDrag);
    expect(isDropzoneDragActive(afterDrop)).toBe(false);
  });

  test('cancel and blur reset even after nested child enters', () => {
    let snap: DropzoneDragSnapshot = initialDropzoneDrag;
    snap = reduceDropzoneDrag(snap, { type: 'enter' });
    snap = reduceDropzoneDrag(snap, { type: 'enter' });
    expect(snap.active).toBe(true);
    expect(reduceDropzoneDrag(snap, { type: 'reset' })).toEqual(initialDropzoneDrag);
  });
});
