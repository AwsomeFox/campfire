/**
 * Shared dirty-form contract: route blocker, beforeunload, and draft persistence
 * (issue #641). Feature forms opt in with a stable form id and dirty signal.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router-dom';
import { UnsavedFormDialog } from '../components/UnsavedFormDialog';
import { RestoreDraftBanner } from '../components/RestoreDraftBanner';
import {
  buildFormDraftEnvelope,
  clearFormDraft,
  formDraftStorageKey,
  isFormDraftStale,
  normalizeDraft,
  readFormDraft,
  writeFormDraft,
  type FormDraftEnvelope,
  type StorageLike,
} from './formDraftStorage';
import {
  deriveProtectedFormSaveStatus,
  protectedFormSaveStatusLabel,
  type ProtectedFormSaveStatus,
} from './protectedFormState';
import { useUnsavedWork } from './useUnsavedWork';

export type UseProtectedFormOptions<T> = {
  formId: string;
  userId: number | null | undefined;
  campaignId: number;
  /** True while the editor is mounted/open. */
  active: boolean;
  dirty: boolean;
  draft: T;
  /** Current server revision for stale-draft detection. */
  serverUpdatedAt?: string | null;
  /** Baseline snapshot used to decide whether a stored draft is worth offering. */
  baseline: T;
  isDraftEqual?: (a: T, b: T) => boolean;
  normalizeDraft?: (storedData: unknown, baseline: T) => T;
  onRestoreDraft: (data: T) => void;
  /** Called after discard from the leave prompt (before navigation proceeds). */
  onDiscard?: () => void;
  onSave?: () => Promise<boolean>;
  unsavedWorkId?: string;
  storage?: StorageLike | null;
};

export type UseProtectedFormResult = {
  saveStatus: ProtectedFormSaveStatus;
  saveStatusLabel: string;
  restorePrompt: ReactNode | null;
  leavePrompt: ReactNode | null;
  clearPersistedDraft: () => void;
};

/** Fallback equality when callers omit `isDraftEqual`. JSON serialization is sufficient for plain draft objects but can mis-compare key order or throw on circular refs. */
function defaultDraftEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useProtectedForm<T>({
  formId,
  userId,
  campaignId,
  active,
  dirty,
  draft,
  serverUpdatedAt,
  baseline,
  isDraftEqual = defaultDraftEqual,
  normalizeDraft: customNormalizeDraft,
  onRestoreDraft,
  onDiscard,
  onSave,
  unsavedWorkId,
  storage,
}: UseProtectedFormOptions<T>): UseProtectedFormResult {
  const normalize = customNormalizeDraft ?? normalizeDraft;
  const storageKey =
    userId != null && Number.isFinite(campaignId)
      ? formDraftStorageKey(userId, campaignId, formId)
      : null;
  const registryId = unsavedWorkId ?? `protected-form:${campaignId}:${formId}`;

  useUnsavedWork(registryId, active && dirty);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!active || !dirty) return;
        event.preventDefault();
        event.returnValue = '';
      },
      [active, dirty],
    ),
  );

  const blocker = useBlocker(active && dirty);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<FormDraftEnvelope<T> | null>(null);
  const [hasStoredDraft, setHasStoredDraft] = useState(false);
  const restoreDismissedRef = useRef(false);
  const onRestoreDraftRef = useRef(onRestoreDraft);
  const onDiscardRef = useRef(onDiscard);
  const onSaveRef = useRef(onSave);
  onRestoreDraftRef.current = onRestoreDraft;
  onDiscardRef.current = onDiscard;
  onSaveRef.current = onSave;

  const clearPersistedDraft = useCallback(() => {
    if (!storageKey) return;
    clearFormDraft(storageKey, storage);
    setHasStoredDraft(false);
    setPendingRestore(null);
  }, [storage, storageKey]);

  // Offer a stored draft once per open cycle when it differs from the baseline.
  // Issue #1986: normalize the restored draft data against baseline so newly-added
  // fields are defaulted rather than restoring as undefined into typed form state.
  useEffect(() => {
    if (!active || !storageKey || restoreDismissedRef.current) {
      if (!active) restoreDismissedRef.current = false;
      return;
    }
    const stored = readFormDraft<T>(storageKey, storage);
    setHasStoredDraft(stored != null);
    if (!stored) {
      setPendingRestore(null);
      return;
    }
    const normalizedData = normalize(stored.data, baseline);
    if (isDraftEqual(normalizedData, baseline)) {
      setPendingRestore(null);
      return;
    }
    setPendingRestore({ ...stored, data: normalizedData });
  }, [active, baseline, isDraftEqual, normalize, storage, storageKey]);

  // Persist while dirty; clear once the form matches the server baseline again.
  useEffect(() => {
    if (!active || !storageKey) return;
    if (!dirty) {
      if (isDraftEqual(draft, baseline)) clearPersistedDraft();
      return;
    }
    writeFormDraft(storageKey, buildFormDraftEnvelope(draft, serverUpdatedAt ?? null), storage);
  }, [active, baseline, clearPersistedDraft, dirty, draft, isDraftEqual, serverUpdatedAt, storage, storageKey]);

  const saveStatus = deriveProtectedFormSaveStatus({
    dirty,
    saving: leaveBusy,
    hasStoredDraft,
  });
  const saveStatusLabel = protectedFormSaveStatusLabel(saveStatus);

  const restorePrompt = useMemo(() => {
    if (!pendingRestore) return null;
    return (
      <RestoreDraftBanner
        savedAt={pendingRestore.savedAt}
        stale={isFormDraftStale(pendingRestore, serverUpdatedAt)}
        onRestore={() => {
          onRestoreDraftRef.current(pendingRestore.data);
          setPendingRestore(null);
          restoreDismissedRef.current = true;
        }}
        onDismiss={() => {
          clearPersistedDraft();
          restoreDismissedRef.current = true;
        }}
      />
    );
  }, [clearPersistedDraft, pendingRestore, serverUpdatedAt]);

  const leavePrompt = useMemo(() => {
    if (blocker.state !== 'blocked') return null;
    return (
      <UnsavedFormDialog
        busy={leaveBusy}
        saveDisabled={!onSaveRef.current}
        onKeep={() => blocker.reset()}
        onDiscard={() => {
          clearPersistedDraft();
          onDiscardRef.current?.();
          blocker.proceed();
        }}
        onSave={() => {
          void (async () => {
            const save = onSaveRef.current;
            if (!save) return;
            setLeaveBusy(true);
            try {
              const ok = await save();
              if (!ok) return;
              clearPersistedDraft();
              blocker.proceed();
            } finally {
              setLeaveBusy(false);
            }
          })();
        }}
      />
    );
  }, [blocker, clearPersistedDraft, leaveBusy]);

  return {
    saveStatus,
    saveStatusLabel,
    restorePrompt,
    leavePrompt,
    clearPersistedDraft,
  };
}
