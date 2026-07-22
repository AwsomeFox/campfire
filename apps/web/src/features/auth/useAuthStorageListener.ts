import { useEffect } from 'react';
import type { Me } from '@campfire/schema';

export const AUTH_STORAGE_KEYS = [
  'cf.user',
  'cf.auth',
  'cf.authToken',
  'authToken',
  'auth_token',
  'user',
] as const;

/**
 * Persists auth state to localStorage when logged in, or removes it when logged out.
 */
export function setAuthStorage(user: Me['user'] | null): void {
  if (typeof localStorage === 'undefined') return;
  if (user) {
    try {
      localStorage.setItem('cf.user', JSON.stringify(user));
      localStorage.setItem('cf.auth', 'true');
      localStorage.setItem('cf.authToken', String(user.id));
    } catch {
      // Ignore storage errors (e.g. quota limits or disabled storage)
    }
  } else {
    clearAuthStorage();
  }
}

/**
 * Clears all auth-related keys from localStorage.
 */
export function clearAuthStorage(): void {
  if (typeof localStorage === 'undefined') return;
  for (const key of AUTH_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Hook attached in auth feature / root listener.
 * Listens for window 'storage' events. When auth token / user state in localStorage
 * is cleared (e.key === null) or removed (newValue is null/empty/falsy) in another tab,
 * triggers `onSignOut` so the tab updates auth state and redirects to login.
 */
export function useAuthStorageListener(onSignOut: () => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleStorageChange = (e: StorageEvent) => {
      const isNullKey = e.key === null;
      const isAuthKey = e.key !== null && (AUTH_STORAGE_KEYS as readonly string[]).includes(e.key);
      const isClearedOrRemoved =
        e.newValue === null || e.newValue === '' || e.newValue === 'null' || e.newValue === 'undefined';

      if (isNullKey || (isAuthKey && isClearedOrRemoved)) {
        onSignOut();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [onSignOut]);
}
