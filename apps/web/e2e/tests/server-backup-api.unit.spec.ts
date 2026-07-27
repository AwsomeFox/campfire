import { expect, test } from '@playwright/test';
import {
  BackupDownloadLimitError,
  downloadServerBackup,
} from '../../src/features/admin/serverBackupApi';

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

test.describe('non-streaming browser fallback phases', () => {
  test('reports streaming while buffering and finalizing before download', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const phases: string[] = [];

    Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: undefined } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => ({
        ok: true,
        headers: new Headers({ 'Content-Type': 'application/zip', 'Content-Length': '3' }),
        body: null,
        blob: async () => {
          expect(phases).toEqual(['streaming']);
          return new Blob([new Uint8Array([1, 2, 3])]);
        },
      }),
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { body: { appendChild: () => undefined }, createElement: () => ({ click: () => undefined, remove: () => undefined }) },
    });
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback: () => void) => { callback(); return 0; } });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    try {
      await expect(downloadServerBackup({ onPhase: (phase) => phases.push(phase) }))
        .resolves.toMatchObject({ bytes: 3, destination: 'browser-memory' });
      expect(phases).toEqual(['streaming', 'finalizing']);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete (globalThis as { window?: Window }).window;
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete (globalThis as { localStorage?: Storage }).localStorage;
      if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch); else delete (globalThis as { fetch?: typeof fetch }).fetch;
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete (globalThis as { document?: Document }).document;
      if (originalTimeout) Object.defineProperty(globalThis, 'setTimeout', originalTimeout);
      if (originalCreateObjectUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
      if (originalRevokeObjectUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
    }
  });

  test('does not report a phase before rejecting an unknown-size fallback', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const phases: string[] = [];

    Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: undefined } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => ({
        ok: true,
        headers: new Headers({ 'Content-Type': 'application/zip' }),
        body: null,
        blob: async () => {
          throw new Error('blob() must not be called');
        },
      }),
    });
    try {
      await expect(downloadServerBackup({ onPhase: (phase) => phases.push(phase) }))
        .rejects.toBeInstanceOf(BackupDownloadLimitError);
      expect(phases).toEqual([]);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete (globalThis as { window?: Window }).window;
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete (globalThis as { localStorage?: Storage }).localStorage;
      if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch); else delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });
});

test('copies a SharedArrayBuffer-backed subarray into a standalone BlobPart', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const originalBlob = Object.getOwnPropertyDescriptor(globalThis, 'Blob');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
  const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const backing = new SharedArrayBuffer(8);
  const bytes = new Uint8Array(backing);
  bytes.set([99, 1, 2, 3, 88]);
  const chunk = new Uint8Array(backing, 1, 3);
  let blobParts: BlobPart[] = [];

  class CapturingBlob {
    constructor(parts: BlobPart[]) {
      blobParts = parts;
    }
  }

  Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: undefined } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => ({
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/zip', 'Content-Length': '3' }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    }),
  });
  Object.defineProperty(globalThis, 'Blob', { configurable: true, value: CapturingBlob });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { body: { appendChild: () => undefined }, createElement: () => ({ click: () => undefined, remove: () => undefined }) },
  });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback: () => void) => { callback(); return 0; } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  try {
    await expect(downloadServerBackup()).resolves.toMatchObject({ bytes: 3, destination: 'browser-memory' });
    expect(blobParts).toHaveLength(1);
    const part = blobParts[0];
    expect(part).toBeInstanceOf(ArrayBuffer);
    if (!(part instanceof ArrayBuffer)) throw new Error('Expected a standalone ArrayBuffer BlobPart.');
    expect(part).not.toBe(backing);
    expect([...new Uint8Array(part)]).toEqual([1, 2, 3]);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete (globalThis as { window?: Window }).window;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete (globalThis as { localStorage?: Storage }).localStorage;
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch); else delete (globalThis as { fetch?: typeof fetch }).fetch;
    if (originalBlob) Object.defineProperty(globalThis, 'Blob', originalBlob); else delete (globalThis as { Blob?: typeof Blob }).Blob;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete (globalThis as { document?: Document }).document;
    if (originalTimeout) Object.defineProperty(globalThis, 'setTimeout', originalTimeout);
    if (originalCreateObjectUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
    if (originalRevokeObjectUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
  }
});
