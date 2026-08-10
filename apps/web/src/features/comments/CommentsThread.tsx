/**
 * Threaded discussion (issue #123). Renders the comment thread for any campaign
 * entity (quest, NPC, location, session, character, campaign, encounter, faction)
 * via EntityDiscussion on each supported detail surface (issue #439). Comments are
 * visible only to campaign members who can see the anchored entity (hidden/secret
 * entities and undiscovered locations return 404 for non-DMs); author-or-DM may
 * edit/delete. One level of threading: top-level comments, with replies nested one deep.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Character, Comment, CommentReplyPage, CommentThread, CommentThreadPage, EntityType } from '@campfire/schema';
import { COMMENTS_THREAD_DEFAULT_LIMIT } from '@campfire/schema';
import { api, API, isStaleWrite } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useAnnounce } from '../../components/Announcer';
import { Field, sanitizeFieldPrefix } from '../../components/Field';
import {
  COMMENT_BODY_HELP,
  COMMENT_BODY_LABEL,
  COMMENT_EDIT_HELP,
  COMMENT_EDIT_LABEL,
  COMMENT_SPEAKER_HELP,
  COMMENT_SPEAKER_LABEL,
  COMMENTS_COMPOSE_PREFIX,
  COMMENTS_EDIT_PREFIX,
  COMMENTS_FIELD,
} from '../../components/formFieldLabels';
import { Btn, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { entityTargetProps } from '../../lib/entityLinks';
import { StaleWriteConflict, type ConflictField } from '../../components/StaleWriteConflict';
import { RevisionHistoryPanel } from '../../components/RevisionHistoryPanel';
import { ReportButton } from '../moderation/ReportDialog';
import { timeAgo, useTimeTick } from '../../lib/format';

interface CommentDraft { body: string }
const COMMENT_CONFLICT_FIELDS: Array<ConflictField<CommentDraft>> = [{ key: 'body', label: 'Comment', merge: true }];



type LoadedThread = CommentThread & {
  /** Replies merged from preview + any load-more pages (deduped by id). */
  loadedReplies: Comment[];
  replyNextCursor: string | null;
  replyHasMore: boolean;
  loadingMoreReplies: boolean;
};

function mergeReplies(existing: Comment[], incoming: Comment[]): Comment[] {
  const seen = new Set(existing.map((c) => c.id));
  const merged = [...existing];
  for (const reply of incoming) {
    if (!seen.has(reply.id)) {
      seen.add(reply.id);
      merged.push(reply);
    }
  }
  return merged;
}

function threadQuery(
  campaignId: number,
  entityType: EntityType,
  entityId: number,
  cursor?: string,
): string {
  const params = new URLSearchParams({
    entityType,
    entityId: String(entityId),
    limit: String(COMMENTS_THREAD_DEFAULT_LIMIT),
  });
  if (cursor) params.set('cursor', cursor);
  return `${API}/campaigns/${campaignId}/comments?${params.toString()}`;
}

function repliesQuery(
  campaignId: number,
  entityType: EntityType,
  entityId: number,
  rootId: number,
  cursor?: string,
): string {
  const params = new URLSearchParams({
    entityType,
    entityId: String(entityId),
  });
  if (cursor) params.set('cursor', cursor);
  return `${API}/campaigns/${campaignId}/comments/${rootId}/replies?${params.toString()}`;
}

export function CommentsThread({
  campaignId,
  entityType,
  entityId,
}: {
  campaignId: number;
  entityType: EntityType;
  entityId: number;
}) {
  useTimeTick();
  const { me } = useAuth();
  const myUserId = me ? String(me.user.id) : null;
  const { isDm, canMemberWrite } = useCampaignAccess();

  const [threads, setThreads] = useState<LoadedThread[]>([]);
  const [totalComments, setTotalComments] = useState(0);
  const [hasMoreThreads, setHasMoreThreads] = useState(false);
  const [nextThreadCursor, setNextThreadCursor] = useState<string | null>(null);
  const [loadingMoreThreads, setLoadingMoreThreads] = useState(false);
  const [ownedCharacters, setOwnedCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const loadSequence = useRef(0);

  const toLoadedThread = useCallback((thread: CommentThread): LoadedThread => ({
    ...thread,
    loadedReplies: thread.replies,
    replyNextCursor: thread.replyNextCursor,
    replyHasMore: thread.replyHasMore,
    loadingMoreReplies: false,
  }), []);

  // Roster is fetched once per campaign/user — not on every comment reload.
  useEffect(() => {
    let cancelled = false;
    if (myUserId == null) {
      setOwnedCharacters([]);
      return;
    }
    void api
      .get<Character[]>(`${API}/campaigns/${campaignId}/characters`)
      .then((characterList) => {
        if (cancelled) return;
        setOwnedCharacters(characterList.filter((character) => character.ownerUserId === myUserId));
      })
      .catch(() => {
        if (!cancelled) setOwnedCharacters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, myUserId]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoadingMoreThreads(false);
    setError(null);
    try {
      const page = await api.get<CommentThreadPage>(
        threadQuery(campaignId, entityType, entityId),
      );
      if (sequence !== loadSequence.current) return;
      setThreads(page.items.map(toLoadedThread));
      setTotalComments(page.totalComments);
      setHasMoreThreads(page.hasMore);
      setNextThreadCursor(page.nextCursor);
    } catch {
      if (sequence !== loadSequence.current) return;
      setError("Couldn't load the discussion.");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [campaignId, entityType, entityId, toLoadedThread]);

  const loadMoreThreads = useCallback(async () => {
    if (!nextThreadCursor || loadingMoreThreads || loading) return;
    const sequence = loadSequence.current;
    setLoadingMoreThreads(true);
    setError(null);
    try {
      const page = await api.get<CommentThreadPage>(
        threadQuery(campaignId, entityType, entityId, nextThreadCursor),
      );
      if (sequence !== loadSequence.current) return;
      setThreads((prev) => {
        const seen = new Set(prev.map((t) => t.root.id));
        return [...prev, ...page.items.filter((t) => !seen.has(t.root.id)).map(toLoadedThread)];
      });
      setTotalComments(page.totalComments);
      setHasMoreThreads(page.hasMore);
      setNextThreadCursor(page.nextCursor);
    } catch {
      if (sequence !== loadSequence.current) return;
      setError("Couldn't load more discussion.");
    } finally {
      setLoadingMoreThreads(false);
    }
  }, [campaignId, entityType, entityId, nextThreadCursor, loadingMoreThreads, loading, toLoadedThread]);

  const loadMoreReplies = useCallback(async (rootId: number) => {
    const thread = threads.find((t) => t.root.id === rootId);
    if (!thread?.replyHasMore || !thread.replyNextCursor || thread.loadingMoreReplies) return;
    setThreads((prev) =>
      prev.map((t) => (t.root.id === rootId ? { ...t, loadingMoreReplies: true } : t)),
    );
    try {
      const page = await api.get<CommentReplyPage>(
        repliesQuery(campaignId, entityType, entityId, rootId, thread.replyNextCursor),
      );
      setThreads((prev) =>
        prev.map((t) =>
          t.root.id === rootId
            ? {
                ...t,
                loadedReplies: mergeReplies(t.loadedReplies, page.items),
                replyCount: page.replyCount,
                replyHasMore: page.hasMore,
                replyNextCursor: page.nextCursor,
                loadingMoreReplies: false,
              }
            : t,
        ),
      );
    } catch {
      setError("Couldn't load more replies.");
      setThreads((prev) =>
        prev.map((t) => (t.root.id === rootId ? { ...t, loadingMoreReplies: false } : t)),
      );
    }
  }, [campaignId, entityType, entityId, threads]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    const refreshAfterResume = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', refreshAfterResume);
    return () => document.removeEventListener('visibilitychange', refreshAfterResume);
  }, [load]);

  function canModerate(c: Comment): boolean {
    return canMemberWrite && (isDm || (myUserId !== null && c.authorUserId === myUserId));
  }

  async function remove(id: number) {
    try {
      await api.delete(`${API}/comments/${id}`);
      setConfirmingDelete(null);
      await load();
    } catch {
      setError("Couldn't delete the comment.");
    }
  }

  return (
    <section
      id={`discussion-${entityType}-${entityId}`}
      className="space-y-3"
      aria-labelledby={`discussion-heading-${entityType}-${entityId}`}
    >
      {/* `card-kicker`, not `text-sm`: nocturne.css sets a bare `h3 { font-size: 1.5625rem }`
          OUTSIDE Tailwind's layers, and unlayered rules beat layered utilities — so the
          `text-sm` this heading used to carry was inert and it rendered at 25px, twice the
          size of every card kicker beside it on the character sheet. */}
      <h3 id={`discussion-heading-${entityType}-${entityId}`} className="card-kicker font-bold flex items-center gap-2">
        Discussion
        {totalComments > 0 && <span className="tag">{totalComments}</span>}
      </h3>
      {error && <ErrorNote message={error} onRetry={load} />}

      {loading ? (
        <p className="text-sm text-secondary">Loading discussion…</p>
      ) : threads.length === 0 ? (
        <p className="text-sm text-secondary">No comments yet — start the conversation.</p>
      ) : (
        <>
        <ul className="space-y-3 list-none p-0 m-0">
          {threads.map(({ root, loadedReplies, replyCount, replyHasMore, loadingMoreReplies }) => (
            <li key={root.id} className="space-y-2">
              <CommentCard
                comment={root}
                campaignId={campaignId}
                canModerate={canModerate(root)}
                onReply={canMemberWrite ? () => setReplyTo(replyTo === root.id ? null : root.id) : undefined}
                onDelete={() => setConfirmingDelete(root.id)}
                onChanged={load}
              />
              {loadedReplies.length > 0 && (
                <ul className="space-y-2 list-none p-0 m-0 ml-5 border-l border-slate-800 pl-4">
                  {loadedReplies.map((reply) => (
                    <li key={reply.id}>
                      <CommentCard
                        comment={reply}
                        campaignId={campaignId}
                        canModerate={canModerate(reply)}
                        onDelete={() => setConfirmingDelete(reply.id)}
                        onChanged={load}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {replyHasMore && (
                <div className="ml-5 pl-4">
                  <Btn density="xs"
                    ghost
                    className="text-xs"
                    onClick={() => void loadMoreReplies(root.id)}
                    disabled={loadingMoreReplies}
                  >
                    {loadingMoreReplies
                      ? 'Loading replies…'
                      : `Show ${replyCount - loadedReplies.length} more ${replyCount - loadedReplies.length === 1 ? 'reply' : 'replies'}`}
                  </Btn>
                </div>
              )}
              {replyTo === root.id && canMemberWrite && (
                <div className="ml-5 pl-4">
                  <ComposeBox
                    campaignId={campaignId}
                    entityType={entityType}
                    entityId={entityId}
                    parentId={root.id}
                    placeholder="Write a reply…"
                    ownedCharacters={ownedCharacters}
                    onPosted={() => {
                      setReplyTo(null);
                      void load();
                    }}
                    onCancel={() => setReplyTo(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
        {hasMoreThreads && (
          <div className="pt-1">
            <Btn density="xs"
              ghost
              className="text-xs"
              onClick={() => void loadMoreThreads()}
              disabled={loadingMoreThreads}
            >
              {loadingMoreThreads ? 'Loading more…' : 'Load older threads'}
            </Btn>
          </div>
        )}
        </>
      )}

      {canMemberWrite && (
      <ComposeBox
        campaignId={campaignId}
        entityType={entityType}
        entityId={entityId}
        parentId={null}
        placeholder="Add to the discussion…"
        ownedCharacters={ownedCharacters}
        onPosted={load}
      />
      )}

      {confirmingDelete !== null && (
        <ConfirmDialog
          title="Delete comment?"
          body="The comment will be hidden and shown as [deleted], but any replies are preserved. A DM or the author can restore it later."
          confirmLabel="Delete"
          onConfirm={() => remove(confirmingDelete)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </section>
  );
}

function CommentCard({
  comment,
  campaignId,
  canModerate,
  onReply,
  onDelete,
  onChanged,
}: {
  comment: Comment;
  campaignId: number;
  canModerate: boolean;
  onReply?: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [base, setBase] = useState<CommentDraft>({ body: comment.body });
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(comment.updatedAt);
  const [conflict, setConflict] = useState<{ base: CommentDraft; theirs: CommentDraft } | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editReactId = useId();
  const editPrefix = `${COMMENTS_EDIT_PREFIX}-${sanitizeFieldPrefix(editReactId)}`;
  const accountLabel = comment.authorName || comment.authorUserId;
  const characterLabel = comment.inCharacter ? comment.characterName?.trim() : null;

  const [restoring, setRestoring] = useState(false);

  async function restoreComment() {
    setRestoring(true);
    setError(null);
    try {
      await api.post(`${API}/comments/${comment.id}/restore`);
      onChanged();
    } catch {
      setError("Couldn't restore the comment.");
    } finally {
      setRestoring(false);
    }
  }

  async function save() {
    // Server rejects identical bodies with 400; treat an unchanged draft as a
    // successful no-op so Save never surfaces a spurious error toast.
    if (draft === comment.body) {
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${API}/comments/${comment.id}`, { body: draft, expectedUpdatedAt });
      setEditing(false);
      setConflict(null);
      setHistoryNonce((value) => value + 1);
      onChanged();
    } catch (err) {
      if (isStaleWrite(err)) {
        try {
          const latest = await api.get<Comment>(`${API}/comments/${comment.id}`);
          const theirs = { body: latest.body };
          setConflict({ base, theirs });
          setBase(theirs);
          setExpectedUpdatedAt(latest.updatedAt);
        } catch {
          setError("The comment changed, but the latest version couldn't be loaded. Your draft is still here.");
        }
      } else {
        setError("Couldn't save the edit.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2" {...entityTargetProps('comment', comment.id)}>
      <div className="flex items-start gap-2 min-w-0">
        {characterLabel && (
          <CharacterAvatar name={characterLabel} avatarUrl={comment.characterAvatarUrl} />
        )}
        <div className="flex items-center gap-2 flex-wrap text-xs min-w-0">
          <span className="font-bold text-slate-300 break-words">{characterLabel || accountLabel}</span>
          {comment.inCharacter && <span className="tag tag-accent">In character</span>}
          {characterLabel && (
            <span className="text-secondary" aria-label={`Posted by account ${accountLabel}`}>
              Posted by {accountLabel}
            </span>
          )}
          <span className="text-timestamp">{timeAgo(comment.createdAt)}</span>
          {comment.updatedAt !== comment.createdAt && (
            // Issue #783: when a NON-author edited the comment (editedBy set), say so
            // honestly instead of a bare "edited" — the author of record never wrote
            // the current body. A self-edit has no editedBy, so it stays a plain badge.
            <span className="text-secondary italic">
              {comment.editedBy ? `edited by ${comment.editedBy}` : 'edited'}
            </span>
          )}
        </div>
      </div>
      {error && <ErrorNote message={error} />}
      {editing ? (
        <div className="space-y-2" data-testid="comment-edit">
          {conflict && (
            <StaleWriteConflict
              base={conflict.base}
              mine={{ body: draft }}
              theirs={conflict.theirs}
              fields={COMMENT_CONFLICT_FIELDS}
              onResolve={(_key, value) => setDraft(String(value))}
              onReloadAll={() => { setDraft(conflict.theirs.body); setBase(conflict.theirs); setConflict(null); }}
            />
          )}
          <Field
            idPrefix={editPrefix}
            name={COMMENTS_FIELD.body}
            as="textarea"
            label={COMMENT_EDIT_LABEL}
            labelClassName="text-[10px] text-slate-300 font-bold uppercase tracking-wide"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            help={COMMENT_EDIT_HELP}
            minHeight={80}
            required
          />
          <div className="flex gap-2 justify-end">
            <Btn density="xs" ghost className="text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Btn>
            <Btn density="xs" className="text-xs" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : conflict ? 'Save resolution' : 'Save'}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="text-sm">
          <Markdown>{comment.body}</Markdown>
        </div>
      )}
      {!editing && (
        <div className="flex gap-3 text-xs">
          {onReply && (
            <button onClick={onReply} className="text-secondary hover:text-[var(--color-neutral-300)]">
              Reply
            </button>
          )}
          {comment.deletedAt !== null ? (
            canModerate && (
              <button
                onClick={restoreComment}
                disabled={restoring}
                className="text-[var(--color-accent)] hover:underline font-semibold disabled:opacity-50"
              >
                {restoring ? 'Restoring…' : 'Restore'}
              </button>
            )
          ) : (
            <>
              {canModerate && (
                <button
                  onClick={() => {
                    setDraft(comment.body);
                    setBase({ body: comment.body });
                    setExpectedUpdatedAt(comment.updatedAt);
                    setConflict(null);
                    setEditing(true);
                  }}
                  className="text-secondary hover:text-[var(--color-neutral-300)]"
                >
                  Edit
                </button>
              )}
              {canModerate && (
                <button onClick={onDelete} className="text-rose-400 hover:text-rose-300">
                  Delete
                </button>
              )}
              {comment.quarantinedAt === null && (
                <ReportButton campaignId={campaignId} targetType="comment" targetId={comment.id} />
              )}
            </>
          )}
        </div>
      )}
      {canModerate && !editing && comment.deletedAt === null && (
        <RevisionHistoryPanel
          entityType="comment"
          entityId={comment.id}
          currentSnapshot={{ body: comment.body }}
          expectedUpdatedAt={comment.updatedAt}
          reloadNonce={historyNonce}
          onRestored={() => { setHistoryNonce((value) => value + 1); onChanged(); }}
          label="Comment history"
        />
      )}
    </div>
  );
}

function CharacterAvatar({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-9 w-9 shrink-0 rounded-full object-cover border border-slate-700"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="h-9 w-9 shrink-0 rounded-full border border-slate-700 bg-slate-800 grid place-items-center text-[11px] font-bold text-slate-300"
    >
      {initials}
    </span>
  );
}

function ComposeBox({
  campaignId,
  entityType,
  entityId,
  parentId,
  placeholder,
  ownedCharacters,
  onPosted,
  onCancel,
}: {
  campaignId: number;
  entityType: EntityType;
  entityId: number;
  parentId: number | null;
  placeholder: string;
  ownedCharacters: Character[];
  onPosted: () => void;
  onCancel?: () => void;
}) {
  const announce = useAnnounce();
  const composeReactId = useId();
  const composePrefix = `${COMMENTS_COMPOSE_PREFIX}-${sanitizeFieldPrefix(composeReactId)}`;
  const [body, setBody] = useState('');
  const [inCharacter, setInCharacter] = useState(false);
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speakerNotice, setSpeakerNotice] = useState<string | null>(null);

  // Keep the selection inside the live owned roster. Ownership can change while the
  // compose box is open (delete/transfer + thread reload); a stale id would otherwise
  // still enable Post and hit a confusing server 404.
  const selectedCharacterId =
    characterId != null && ownedCharacters.some((character) => character.id === characterId)
      ? characterId
      : null;

  useEffect(() => {
    if (!inCharacter) return;
    if (ownedCharacters.length === 0) {
      setInCharacter(false);
      setCharacterId(null);
      const message = 'In-character posting turned off — no owned characters remain.';
      setSpeakerNotice(message);
      announce(message);
      return;
    }
    // Stale speaker left the roster: clear selection (do not silently switch) and
    // require an explicit choice, with visible + announced feedback.
    if (characterId != null && selectedCharacterId == null) {
      setCharacterId(null);
      const message = 'Your previous speaking character is no longer available. Choose another.';
      setSpeakerNotice(message);
      announce(message);
    }
  }, [announce, characterId, inCharacter, ownedCharacters.length, selectedCharacterId]);

  async function post() {
    if (!body.trim()) return;
    if (inCharacter && selectedCharacterId == null) return;
    setPosting(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/comments`, {
        entityType,
        entityId,
        parentId: parentId ?? undefined,
        body,
        inCharacter,
        characterId: inCharacter ? selectedCharacterId : undefined,
      });
      setBody('');
      setInCharacter(false);
      setCharacterId(null);
      onPosted();
    } catch {
      setError("Couldn't post the comment.");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="comments-compose">
      {error && <ErrorNote message={error} />}
      {speakerNotice && (
        <p role="status" className="text-xs text-amber-300/90">
          {speakerNotice}
        </p>
      )}
      <Field
        idPrefix={composePrefix}
        name={COMMENTS_FIELD.body}
        as="textarea"
        label={COMMENT_BODY_LABEL}
        labelClassName="text-[10px] text-slate-300 font-bold uppercase tracking-wide"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        help={COMMENT_BODY_HELP}
        minHeight={72}
        required
      />
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 sm:justify-end">
        <label
          className={`flex items-center gap-1.5 text-xs mr-auto ${ownedCharacters.length ? 'text-secondary cursor-pointer' : 'text-secondary cursor-not-allowed'}`}
          title={ownedCharacters.length ? undefined : 'Create or claim a character before posting in character.'}
        >
          <input
            type="checkbox"
            checked={inCharacter}
            disabled={ownedCharacters.length === 0}
            onChange={(e) => {
              const checked = e.target.checked;
              setSpeakerNotice(null);
              setInCharacter(checked);
              setCharacterId(
                checked
                  ? (selectedCharacterId ?? ownedCharacters[0]?.id ?? null)
                  : null,
              );
            }}
          />
          In character
        </label>
        {inCharacter && (
          <Field
            idPrefix={composePrefix}
            name={COMMENTS_FIELD.characterId}
            as="select"
            label={COMMENT_SPEAKER_LABEL}
            labelClassName="text-xs text-slate-400"
            className="field min-w-0 sm:max-w-[18rem]"
            selectClassName="cf-select text-xs w-full cf-density-xs"
            value={selectedCharacterId != null ? String(selectedCharacterId) : ''}
            onChange={(e) => {
              const next = Number(e.target.value);
              setSpeakerNotice(null);
              setCharacterId(
                Number.isInteger(next) && ownedCharacters.some((character) => character.id === next)
                  ? next
                  : null,
              );
            }}
            help={COMMENT_SPEAKER_HELP}
            required
          >
            {selectedCharacterId == null && (
              <option value="" disabled>
                Choose a character…
              </option>
            )}
            {ownedCharacters.map((character) => (
              <option key={character.id} value={character.id}>{character.name}</option>
            ))}
          </Field>
        )}
        {onCancel && (
          <Btn density="xs" ghost className="text-xs" onClick={onCancel}>
            Cancel
          </Btn>
        )}
        <Btn density="xs"
          className="text-xs self-end sm:self-auto"
          onClick={post}
          disabled={posting || !body.trim() || (inCharacter && selectedCharacterId == null)}
        >
          {posting ? 'Posting…' : 'Post'}
        </Btn>
      </div>
    </div>
  );
}
