import { EventEmitter } from 'node:events';
import { BackupController } from '../../src/modules/backup/backup.controller';

function response(): EventEmitter & { writableEnded: boolean; status: jest.Mock; set: jest.Mock } {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    status: jest.fn(),
    set: jest.fn(),
  });
  res.status.mockReturnValue(res);
  res.set.mockReturnValue(res);
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
});
