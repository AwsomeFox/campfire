import { removePathVerified, errnoCode } from '../../src/modules/attachments/fs-deletion.util';

describe('fs-deletion.util (issue #727)', () => {
  it('treats ENOENT from rmSync as success', () => {
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
});
