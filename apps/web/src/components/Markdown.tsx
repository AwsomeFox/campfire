import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Rendered, sanitized markdown body. Plain text is always valid input. */
export function Markdown({ children, className = '' }: { children: string; className?: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(children ?? '', { async: false }) as string),
    [children],
  );
  return <div className={`cf-prose text-sm text-slate-300 space-y-2 ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
