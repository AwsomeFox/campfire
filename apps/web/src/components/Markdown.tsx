import { useCallback, useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { MentionTarget } from '@campfire/schema';
import { useMentions, mentionRoute } from '../app/MentionsContext';

/** Escape a string for safe inclusion in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Auto-link known entity names (issue #64 cross-linking). Walks the rendered
 * DOM's text nodes and wraps the first occurrences of any campaign entity name
 * in a link to that entity's page — so a recap that merely types "Vex" becomes
 * a link to the NPC. Skips text already inside links, code, or headings so we
 * never nest anchors or rewrite code samples. Runs on the sanitized DOM (never
 * on untrusted HTML), and the injected anchors are same-origin app routes only.
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

    // Longest names first so "Vex the Innkeeper" wins over "Vex".
    const sorted = [...targets].filter((t) => t.name.trim().length >= 2).sort((a, b) => b.name.length - a.name.length);
    if (sorted.length === 0) return;
    const byName = new Map<string, MentionTarget>();
    for (const t of sorted) {
      const key = t.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, t);
    }
    const pattern = new RegExp(`\\b(${sorted.map((t) => escapeRegExp(t.name)).join('|')})\\b`, 'gi');

    const SKIP = new Set(['A', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let el = node.parentElement;
        while (el && el !== root) {
          if (SKIP.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return pattern.test(node.nodeValue ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const textNodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

    for (const textNode of textNodes) {
      const text = textNode.nodeValue ?? '';
      pattern.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m: RegExpExecArray | null;
      let linked = false;
      while ((m = pattern.exec(text))) {
        const target = byName.get(m[0].toLowerCase());
        if (!target) continue;
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const a = document.createElement('a');
        a.setAttribute('href', `/c/${campaignId}/${mentionRoute[target.type]}/${target.id}`);
        a.setAttribute('data-mention', `${target.type}:${target.id}`);
        a.className = 'cf-mention';
        a.textContent = m[0];
        frag.appendChild(a);
        last = m.index + m[0].length;
        linked = true;
      }
      if (linked) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        textNode.parentNode?.replaceChild(frag, textNode);
      }
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
      className={`cf-prose text-sm text-slate-300 space-y-2 ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
