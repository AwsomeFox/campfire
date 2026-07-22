import { expect, test } from '@playwright/test';
import {
  AUTH_STORAGE_KEYS,
  clearAuthStorage,
  setAuthStorage,
} from '../../src/features/auth/useAuthStorageListener';

test.describe('Auth Storage Utilities', () => {
  test('setAuthStorage writes auth keys to localStorage', () => {
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const store: Record<string, string> = {};

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        setItem(key: string, value: string) {
          store[key] = value;
        },
        getItem(key: string) {
          return store[key] ?? null;
        },
        removeItem(key: string) {
          delete store[key];
        },
        clear() {
          for (const key of Object.keys(store)) delete store[key];
        },
      },
    });

    try {
      setAuthStorage({ id: 42, username: 'testuser' });
      expect(store['cf.user']).toBe(JSON.stringify({ id: 42, username: 'testuser' }));
      expect(store['cf.auth']).toBe('true');
      expect(store['cf.authToken']).toBe('42');

      clearAuthStorage();
      for (const key of AUTH_STORAGE_KEYS) {
        expect(store[key]).toBeUndefined();
      }
    } finally {
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test('setAuthStorage(null) clears auth keys from localStorage', () => {
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const store: Record<string, string> = {
      'cf.user': '{"id":1}',
      'cf.auth': 'true',
      'cf.authToken': '1',
    };

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        setItem(key: string, value: string) {
          store[key] = value;
        },
        getItem(key: string) {
          return store[key] ?? null;
        },
        removeItem(key: string) {
          delete store[key];
        },
        clear() {
          for (const key of Object.keys(store)) delete store[key];
        },
      },
    });

    try {
      setAuthStorage(null);
      for (const key of AUTH_STORAGE_KEYS) {
        expect(store[key]).toBeUndefined();
      }
    } finally {
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
