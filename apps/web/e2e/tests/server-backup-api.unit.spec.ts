import { expect, test } from '@playwright/test';
import { downloadServerBackup } from '../../src/features/admin/serverBackupApi';

function installDismissedPicker(): () => void {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      showSaveFilePicker: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
  return () => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else delete (globalThis as { window?: Window }).window;
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  };
}

function withoutThrowIfAborted(signal: AbortSignal): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(signal, 'throwIfAborted');
  Object.defineProperty(signal, 'throwIfAborted', { configurable: true, value: undefined });
  return () => {
    if (descriptor) Object.defineProperty(signal, 'throwIfAborted', descriptor);
    else delete (signal as { throwIfAborted?: unknown }).throwIfAborted;
  };
}

test.describe('backup destination picker cancellation', () => {
  test('keeps a dismissed picker as AbortError when AbortSignal lacks throwIfAborted', async () => {
    const restoreGlobals = installDismissedPicker();
    const controller = new AbortController();
    const restoreSignal = withoutThrowIfAborted(controller.signal);
    try {
      await expect(downloadServerBackup({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      restoreSignal();
      restoreGlobals();
    }
  });

  test('keeps an already-aborted signal as AbortError when the picker closes', async () => {
    const restoreGlobals = installDismissedPicker();
    const controller = new AbortController();
    controller.abort();
    const restoreSignal = withoutThrowIfAborted(controller.signal);
    try {
      await expect(downloadServerBackup({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      restoreSignal();
      restoreGlobals();
    }
  });
});
