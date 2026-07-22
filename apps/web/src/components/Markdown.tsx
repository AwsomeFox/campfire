import { useCallback, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { MentionTarget } from '@campfire/schema';
import { useMentions } from '../app/MentionsContext';
import {
  cfLinkHref,
  mentionTargetHref,
  parseCfLink,
  resolveUniqueByName,
  type NavigableEntityType,
} from '../lib/entityLinks';
import { buildMentionCandidates, findMentionMatches } from '../lib/mentionMatching';

/**
 * Resolve `/.cf/<type>/<id>` mention anchors authored inside markdown links.
 *
 * Identity persistence (issue #739): a mention written as `[Vex](/.cf/npc/5)`
 * binds the link to NPC #5 — not to the word "Vex". After parsing the rendered
 * DOM, every `<a href="/.cf/...">` is rewritten in place to the entity's
 * canonical app URL (cfLinkHref) and its label is updated to the entity's
 * CURRENT name when that name differs from what the author typed (rename
 * tolerance). A token whose target was deleted, hidden from this viewer, or is
 * no longer navigable degrades to plain text — the authored label stays visible
 * and no broken link is emitted. The `data-mention` attribute is set so the SPA
 * click handler below still recognizes these anchors and the existing styling
 * still applies.
 */
function useTypedMentionLinks(
  ref: React.RefObject<HTMLDivElement | null>,
  html: string,
  campaignId: number | undefined,
  targets: ReadonlyArray<MentionTarget>,
) {
  useEffect(() => {
    const root = ref.current;
    if (!root || campaignId === undefined) return;
    // Index visible mention targets by `${type}:${id}` so a typed token resolves
    // to the SAME role-filtered record the picker offered (hidden entities never
    // appear here, so their tokens correctly degrade to plain text for that user).
    const byKey = new Map<string, MentionTarget>();
    for (const t of targets) byKey.set(`${t.type}:${t.id}`, t);

    const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href^="/.cf/"]');
    for (const a of anchors) {
      const link = parseCfLink(a.getAttribute('href'));
      if (!link) continue;
      const href = cfLinkHref(campaignId, link);
      const key = `${link.type}:${link.id}`;
      const target = byKey.get(key);
      if (!href || !target) {
        // Degrade to plain text — preserve the authored label, drop the anchor.
        const text = document.createTextNode(a.textContent ?? '');
        a.replaceWith(text);
        continue;
      }
      a.setAttribute('href', href);
      a.setAttribute('data-mention', key);
      a.setAttribute('data-entity-type', String(link.type satisfies NavigableEntityType));
      a.setAttribute('data-entity-id', String(link.id));
      a.className = 'cf-mention';
      // Rename tolerance: if the author's label no longer matches the entity's
      // current name, refresh it so the prose reads naturally without re-editing.
      // BUT only when the current name is itself unambiguous — if two visible
      // records share that name, the author's hand-written label is the only
      // disambiguating hint and must be preserved (rewriting both to the same
      // name would erase the distinction the typed token was added to express).
      const label = (a.textContent ?? '').trim();
      if (label && label !== target.name && resolveUniqueByName(targets, target.name)) {
        a.textContent = target.name;
      }
    }
  }, [ref, html, campaignId, targets]);
}

/**
 * Auto-link known entity names (issue #64 cross-linking). Walks the rendered
 * DOM's text nodes and wraps the first occurrences of any campaign entity name
 * in a link to that entity's page — so a recap that merely types "Vex" becomes
 * a link to the NPC. Skips text already inside links, code, or headings so we
 * never nest anchors or rewrite code samples. Runs on the sanitized DOM (never
 * on untrusted HTML), and the injected anchors are same-origin app routes only.
 *
 * Same-name disambiguation (issue #739): when two visible targets share a name,
 * neither is auto-linked — silently picking the first one is exactly the
 * collision a typed `cf:` link exists to resolve, so the author is expected to
 * disambiguate explicitly. `resolveUniqueByName` returns null on a collision.
 */
function useAutoLink(
  ref: React.RefObject<HTMLDivElement | null>,
  html: string,
  campaignId: number | undefined,
  targets: MentionTarget[],
) {
  useEffect(() => {
    const root = ref.current;
    if (!root || campaignId === undefined || targets.length === 0) return;

    const candidates = buildMentionCandidates(targets);
    if (candidates.length === 0) return;

    const SKIP = new Set(['A', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let el = node.parentElement;
        while (el && el !== root) {
          if (SKIP.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const textNodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

    for (const textNode of textNodes) {
      const text = textNode.nodeValue ?? '';
      const matches = findMentionMatches(text, candidates);
      if (matches.length === 0) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const match of matches) {
        if (match.start > last) frag.appendChild(document.createTextNode(text.slice(last, match.start)));
        const a = document.createElement('a');
        a.setAttribute('href', mentionTargetHref(campaignId, match.target));
        a.setAttribute('data-mention', `${match.target.type}:${match.target.id}`);
        a.className = 'cf-mention';
        a.textContent = text.slice(match.start, match.end);
        frag.appendChild(a);
        last = match.end;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }, [ref, html, campaignId, targets]);
}

/** Rendered, sanitized markdown body. Plain text is always valid input. */
export function Markdown({ children, className = '' }: { children: string; className?: string }) {
  const { campaignId, targets } = useMentions();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(children ?? '', { async: false }) as string),
    [children],
  );
  useAutoLink(ref, html, campaignId, targets);
  useTypedMentionLinks(ref, html, campaignId, targets);

  // Client-side navigation for auto-linked mentions (they're injected DOM nodes,
  // not react-router <Link>s, so intercept the click to avoid a full page reload).
  const onClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement).closest('a[data-mention]') as HTMLAnchorElement | null;
      if (!anchor || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      navigate(href);
    },
    [navigate],
  );

  return (
    <div
      ref={ref}
      onClick={onClick}
      className={`cf-prose reading-text text-slate-300 space-y-2 ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
