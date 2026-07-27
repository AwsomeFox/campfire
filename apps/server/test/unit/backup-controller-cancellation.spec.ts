import { EventEmitter } from 'node:events';
import { BackupController } from '../../src/modules/backup/backup.controller';

function response(): EventEmitter & {
  writableEnded: boolean;
  headersSent: boolean;
  destroyed: boolean;
  status: jest.Mock;
  set: jest.Mock;
  destroy: jest.Mock;
} {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    headersSent: false,
    destroyed: false,
    status: jest.fn(),
    set: jest.fn(),
    destroy: jest.fn(),
  });
  res.status.mockReturnValue(res);
  res.set.mockReturnValue(res);
  res.destroy.mockImplementation(() => {
    res.destroyed = true;
    return res;
  });
  return res;
}

describe('BackupController download cancellation', () => {
  it('suppresses the expected build cancellation after the client disconnects', async () => {
    const req = new EventEmitter();
    const res = response();
    const backup = {
      backupFilename: jest.fn(() => 'backup.zip'),
      buildBackup: jest.fn(async () => {
        res.emit('close');
        throw new Error('Backup generation cancelled');
      }),
    };
    await expect(new BackupController(backup as never).download(req as never, res as never)).resolves.toBeUndefined();
    expect(backup.buildBackup).toHaveBeenCalledTimes(1);
  });

  it('does not hide a genuine failure merely because a cancellation signal exists', async () => {
    const req = new EventEmitter();
    const res = response();
    const backup = {
      backupFilename: jest.fn(() => 'backup.zip'),
      buildBackup: jest.fn(async () => {
        res.emit('close');
        throw new Error('Backup failed reconciliation');
      }),
    };
    await expect(new BackupController(backup as never).download(req as never, res as never)).rejects.toThrow(
      'reconciliation',
    );
  });

  it('destroys rather than rethrows when the archive fails after bytes are committed', async () => {
    const req = new EventEmitter();
    const res = response();
    const backup = {
      backupFilename: jest.fn(() => 'backup.zip'),
      // The compressed-size ceiling is enforced mid-stream, so this is the ordinary
      // shape of an oversized archive: headers and bytes are already on the wire.
      buildBackup: jest.fn(async () => {
        res.headersSent = true;
        throw new Error('Backup archive exceeds the 1073741824 byte compressed restore limit');
      }),
    };
    // Rethrowing here would have Nest write a JSON error over the in-flight ZIP,
    // producing a body that is half archive and half error message.
    await expect(new BackupController(backup as never).download(req as never, res as never)).resolves.toBeUndefined();
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect((res.destroy.mock.calls[0][0] as Error).message).toContain('compressed restore limit');
  });

  it('does not double-destroy a response the archive pipeline already tore down', async () => {
    const req = new EventEmitter();
    const res = response();
    const backup = {
      backupFilename: jest.fn(() => 'backup.zip'),
      buildBackup: jest.fn(async () => {
        res.headersSent = true;
        res.destroyed = true;
        throw new Error('Backup archive exceeds the 1073741824 byte compressed restore limit');
      }),
    };
    await expect(new BackupController(backup as never).download(req as never, res as never)).resolves.toBeUndefined();
    expect(res.destroy).not.toHaveBeenCalled();
  });
});
