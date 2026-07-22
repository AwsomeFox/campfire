import { useEffect } from 'react';
export const AUTH_STORAGE_KEYS = ['cf.authUserId'] as const;

/**
 * Persists auth state to localStorage when logged in, or removes it when logged out.
 */
export function setAuthStorage(user: { id: number } | null): void {
  if (typeof localStorage === 'undefined') return;
  if (user) {
    try {
      // Cross-tab session sentinel only: never persist a token or user profile.
      localStorage.setItem(AUTH_STORAGE_KEYS[0], String(user.id));
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
 * Listens for Campfire's localStorage session sentinel. Removal invokes
 * `onSignOut`; the caller clears auth state and the route guard performs any
 * redirect. A per-login guard coalesces repeated removal events defensively.
 */
export function useAuthStorageListener(onSignOut: () => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let signOutHandled = false;
    const handleStorageChange = (e: StorageEvent) => {
      try {
        if (e.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      const isNullKey = e.key === null;
      const isAuthKey = e.key !== null && (AUTH_STORAGE_KEYS as readonly string[]).includes(e.key);
      const isClearedOrRemoved =
        e.newValue === null || e.newValue === '' || e.newValue === 'null' || e.newValue === 'undefined';

      if (isAuthKey && !isClearedOrRemoved) {
        signOutHandled = false;
        return;
      }
      if (!signOutHandled && (isNullKey || (isAuthKey && isClearedOrRemoved))) {
        signOutHandled = true;
        onSignOut();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [onSignOut]);
}
