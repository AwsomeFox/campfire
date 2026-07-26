/**
 * Idempotency keys for retryable mutations (issue #580).
 *
 * TanStack Query used to auto-retry every mutation once on a network/5xx failure. For a
 * relative write — "deal 8 damage", "advance the turn" — that is only safe if the server
 * can tell a retry from a fresh intent, and it could not: nothing on the wire identified
 * the operation. A request that COMMITTED and then lost its response got replayed, and the
 * damage landed twice.
 *
 * The fix has two halves and both live here:
 *
 *  1. **Retry is opt-in, not opt-out.** {@link queryClient} now defaults mutations to
 *     `retry: false`. A mutation only gets automatic retry by going through
 *     {@link useKeyedMutation}, which is also the only thing that mints a key. Making the
 *     two inseparable is deliberate: a future endpoint cannot accidentally acquire retry
 *     without acquiring protection, which is the failure mode an opt-OUT list invites.
 *
 *  2. **The key is minted once per INTENT, at the click.** `mutate()` stamps a fresh id
 *     into the variables; TanStack reuses those same variables for every retry attempt, so
 *     all attempts of one click carry one key. Minting inside the fetch wrapper — the
 *     obvious-looking place — would produce a new key per attempt and protect nothing.
 */
import { useMemo } from 'react';
import { useMutation, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query';
import { ApiError } from './api';

/** Field name carrying the operation id in request bodies. Matches the server DTOs. */
export const IDEMPOTENCY_FIELD = 'idempotencyKey' as const;

/**
 * A fresh operation id. Crypto-random where available; the fallback only needs to be
 * unique among one browser's in-flight operations, since the server scopes keys by actor
 * and encounter and rejects cross-scope reuse outright.
 */
export function newOperationId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Variables a keyed mutation's `mutationFn` receives — always carrying the operation id. */
export interface HasOperationId {
  idempotencyKey: string;
}

/** What the CALLER passes to `mutate` — everything except the key, which is minted here. */
export type WithoutOperationId<TVars> = Omit<TVars, 'idempotencyKey'>;

/**
 * Retry rule for mutations that ARE key-protected. A 4xx is terminal (it will not heal, and
 * a 409 IDEMPOTENCY_KEY_REUSE in particular means retrying is actively wrong). Everything
 * else — a dropped socket, a 502 from a reverse proxy, a 504 — is exactly the ambiguous
 * case the key exists for, so one retry is safe: either it arrives fresh, or the server
 * recognizes the key and replays the original response.
 */
export function retryProtectedMutation(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/**
 * `useMutation` for a non-idempotent endpoint that accepts an `idempotencyKey`.
 *
 * Identical to `useMutation` except that `mutate`/`mutateAsync` take the caller's variables
 * WITHOUT a key and inject one, and automatic retry is enabled. The mutation function
 * receives the key in its variables and must forward it in the request body — that is the
 * whole contract, and it is why the key is threaded through variables rather than hidden in
 * a fetch interceptor.
 */
export function useKeyedMutation<TData, TVars extends HasOperationId, TContext = unknown>(
  options: UseMutationOptions<TData, unknown, TVars, TContext>,
): Omit<UseMutationResult<TData, unknown, TVars, TContext>, 'mutate' | 'mutateAsync'> & {
  mutate: (vars: WithoutOperationId<TVars>) => void;
  mutateAsync: (vars: WithoutOperationId<TVars>) => Promise<TData>;
} {
  const inner = useMutation<TData, unknown, TVars, TContext>({
    retry: retryProtectedMutation,
    ...options,
  });

  return useMemo(() => {
    const { mutate, mutateAsync, ...rest } = inner;
    // One id per call — i.e. per user intent. Every retry of THIS call reuses these exact
    // variables, so the server sees one key across all attempts of one click.
    const withKey = (vars: WithoutOperationId<TVars>): TVars =>
      ({ ...vars, [IDEMPOTENCY_FIELD]: newOperationId() }) as unknown as TVars;
    return {
      ...rest,
      mutate: (vars: WithoutOperationId<TVars>) => mutate(withKey(vars)),
      mutateAsync: (vars: WithoutOperationId<TVars>) => mutateAsync(withKey(vars)),
    };
  }, [inner]);
}
