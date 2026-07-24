import { removePathVerified, errnoCode } from '../../src/modules/attachments/fs-deletion.util';

describe('fs-deletion.util (issue #727)', () => {
  it('treats missing path as success (ENOENT from rmSync)', () => {
    const result = removePathVerified('/tmp/missing.png', {
      rmSync: () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
      existsSync: () => false,
    });
    expect(result).toEqual({ ok: true });
  });

  it('skips pre-stat and treats absent path as success when rmSync is a no-op', () => {
    const result = removePathVerified('/tmp/gone.png', {
      rmSync: () => {
        /* force rm on already-absent path — no throw */
      },
      existsSync: () => false,
    });
    expect(result).toEqual({ ok: true });
  });

  it('surfaces EACCES without claiming erasure', () => {
    const result = removePathVerified('/tmp/locked.png', {
      rmSync: () => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
      existsSync: () => true,
    });
    expect(result).toEqual({ ok: false, code: 'EACCES', message: 'permission denied' });
  });

  it('reports failure when the path still exists after rmSync', () => {
    const result = removePathVerified('/tmp/stuck.png', {
      rmSync: () => {
        /* no-op — simulates a silent failure / busy mount */
      },
      existsSync: () => true,
    });
    expect(result).toEqual({
      ok: false,
      code: 'EEXIST',
      message: 'Path still present after removal',
    });
  });

  it('errnoCode reads Node err.code', () => {
    const err = new Error('x') as NodeJS.ErrnoException;
    err.code = 'EBUSY';
    expect(errnoCode(err)).toBe('EBUSY');
  });

  it('errnoCode returns empty when code is missing or non-primitive', () => {
    expect(errnoCode(null)).toBe('');
    expect(errnoCode('boom')).toBe('');
    expect(errnoCode({ code: undefined })).toBe('');
    expect(errnoCode({ code: { nested: true } })).toBe('');
    expect(errnoCode({})).toBe('');
  });
});
