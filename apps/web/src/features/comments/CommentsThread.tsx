/**
 * Threaded discussion (issue #123). Renders the comment thread for any campaign
 * entity (session/recap today; wired to reuse the entityType/entityId convention
 * for quests/npcs/locations later) plus a compose box. Comments are visible to
 * every campaign member; author-or-DM may edit/delete. One level of threading:
 * top-level comments, with replies nested one deep.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Character, Comment, EntityType } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useAnnounce } from '../../components/Announcer';
import { Btn, TextArea, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { entityTargetProps } from '../../lib/entityLinks';

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
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
  const { me, roleIn } = useAuth();
  const myUserId = me ? String(me.user.id) : null;
  const isDm = roleIn(campaignId) === 'dm';

  const [comments, setComments] = useState<Comment[]>([]);
  const [ownedCharacters, setOwnedCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);

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
    setError(null);
    try {
      const list = await api.get<Comment[]>(
        `${API}/campaigns/${campaignId}/comments?entityType=${entityType}&entityId=${entityId}`,
      );
      setComments(list);
    } catch {
      setError("Couldn't load the discussion.");
    } finally {
      setLoading(false);
    }
  }, [campaignId, entityType, entityId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Group into top-level comments + their direct replies (one level deep).
  const threads = useMemo(() => {
    const roots = comments.filter((c) => c.parentId === null);
    const repliesByParent = new Map<number, Comment[]>();
    for (const c of comments) {
      if (c.parentId !== null) {
        const arr = repliesByParent.get(c.parentId) ?? [];
        arr.push(c);
        repliesByParent.set(c.parentId, arr);
      }
    }
    return roots.map((root) => ({ root, replies: repliesByParent.get(root.id) ?? [] }));
  }, [comments]);

  function canModerate(c: Comment): boolean {
    return isDm || (myUserId !== null && c.authorUserId === myUserId);
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
    <section className="space-y-3" aria-labelledby={`discussion-${entityType}-${entityId}`}>
      <h3 id={`discussion-${entityType}-${entityId}`} className="text-sm font-bold text-slate-400 uppercase tracking-wide flex items-center gap-2">
        Discussion
        {comments.length > 0 && <span className="tag">{comments.length}</span>}
      </h3>
      {error && <ErrorNote message={error} onRetry={load} />}

      {loading ? (
        <p className="text-sm text-slate-600">Loading discussion…</p>
      ) : threads.length === 0 ? (
        <p className="text-sm text-slate-600">No comments yet — start the conversation.</p>
      ) : (
        <ul className="space-y-3 list-none p-0 m-0">
          {threads.map(({ root, replies }) => (
            <li key={root.id} className="space-y-2">
              <CommentCard
                comment={root}
                canModerate={canModerate(root)}
                onReply={() => setReplyTo(replyTo === root.id ? null : root.id)}
                onDelete={() => setConfirmingDelete(root.id)}
                onChanged={load}
              />
              {replies.length > 0 && (
                <ul className="space-y-2 list-none p-0 m-0 ml-5 border-l border-slate-800 pl-4">
                  {replies.map((reply) => (
                    <li key={reply.id}>
                      <CommentCard
                        comment={reply}
                        canModerate={canModerate(reply)}
                        onDelete={() => setConfirmingDelete(reply.id)}
                        onChanged={load}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {replyTo === root.id && (
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
      )}

      <ComposeBox
        campaignId={campaignId}
        entityType={entityType}
        entityId={entityId}
        parentId={null}
        placeholder="Add to the discussion…"
        ownedCharacters={ownedCharacters}
        onPosted={load}
      />

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
  canModerate,
  onReply,
  onDelete,
  onChanged,
}: {
  comment: Comment;
  canModerate: boolean;
  onReply?: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountLabel = comment.authorName || comment.authorUserId;
  const characterLabel = comment.inCharacter ? comment.characterName?.trim() : null;

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
      await api.patch(`${API}/comments/${comment.id}`, { body: draft });
      setEditing(false);
      onChanged();
    } catch {
      setError("Couldn't save the edit.");
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
            <span className="text-slate-500" aria-label={`Posted by account ${accountLabel}`}>
              Posted by {accountLabel}
            </span>
          )}
          <span className="text-slate-600">{timeAgo(comment.createdAt)}</span>
          {comment.updatedAt !== comment.createdAt && (
            // Issue #783: when a NON-author edited the comment (editedBy set), say so
            // honestly instead of a bare "edited" — the author of record never wrote
            // the current body. A self-edit has no editedBy, so it stays a plain badge.
            <span className="text-slate-600 italic">
              {comment.editedBy ? `edited by ${comment.editedBy}` : 'edited'}
            </span>
          )}
        </div>
      </div>
      {error && <ErrorNote message={error} />}
      {editing ? (
        <div className="space-y-2">
          <TextArea style={{ minHeight: 80 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2 justify-end">
            <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Btn>
            <Btn className="!min-h-0 !py-1 text-xs" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
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
            <button onClick={onReply} className="text-slate-500 hover:text-slate-300">
              Reply
            </button>
          )}
          {canModerate && (
            <button onClick={() => setEditing(true)} className="text-slate-500 hover:text-slate-300">
              Edit
            </button>
          )}
          {canModerate && (
            <button onClick={onDelete} className="text-rose-500/80 hover:text-rose-400">
              Delete
            </button>
          )}
        </div>
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
    <div className="space-y-2">
      {error && <ErrorNote message={error} />}
      {speakerNotice && (
        <p role="status" className="text-xs text-amber-300/90">
          {speakerNotice}
        </p>
      )}
      <TextArea
        style={{ minHeight: 72 }}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
      />
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 sm:justify-end">
        <label
          className={`flex items-center gap-1.5 text-xs mr-auto ${ownedCharacters.length ? 'text-slate-500 cursor-pointer' : 'text-slate-600 cursor-not-allowed'}`}
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
          <label className="flex items-center gap-2 text-xs text-slate-400 min-w-0 sm:max-w-[18rem]">
            <span className="whitespace-nowrap">Speaking as</span>
            <select
              className="cf-select !min-h-0 !py-1.5 text-xs flex-1 min-w-0"
              value={selectedCharacterId ?? ''}
              onChange={(e) => {
                const next = Number(e.target.value);
                setSpeakerNotice(null);
                setCharacterId(
                  Number.isInteger(next) && ownedCharacters.some((character) => character.id === next)
                    ? next
                    : null,
                );
              }}
              aria-label="Speaking character"
            >
              {selectedCharacterId == null && (
                <option value="" disabled>
                  Choose a character…
                </option>
              )}
              {ownedCharacters.map((character) => (
                <option key={character.id} value={character.id}>{character.name}</option>
              ))}
            </select>
          </label>
        )}
        {onCancel && (
          <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={onCancel}>
            Cancel
          </Btn>
        )}
        <Btn
          className="!min-h-0 !py-1 text-xs self-end sm:self-auto"
          onClick={post}
          disabled={posting || !body.trim() || (inCharacter && selectedCharacterId == null)}
        >
          {posting ? 'Posting…' : 'Post'}
        </Btn>
      </div>
    </div>
  );
}
