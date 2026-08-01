import { useState, useRef, KeyboardEvent, forwardRef } from 'react';
import { TextArea, Btn, Card } from './ui';
import { Markdown } from './Markdown';

import { applyMarkdownFormat } from './markdownFormatter';

export interface MarkdownEditorProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  showToolbar?: boolean;
}

export const MarkdownEditor = forwardRef<HTMLTextAreaElement, MarkdownEditorProps>(
  function MarkdownEditor({ showToolbar = false, className = '', value = '', onChange, onKeyDown, ...props }, ref) {
    const [tab, setTab] = useState<'write' | 'preview'>('write');
    const localRef = useRef<HTMLTextAreaElement>(null);
    const textareaRef = (ref as React.RefObject<HTMLTextAreaElement>) || localRef;

    const applyFormat = (prefix: string, suffix: string) => {
      const el = textareaRef.current;
      if (!el) return;
      
      const { newValue, newSelectionStart, newSelectionEnd } = applyMarkdownFormat(
        typeof value === 'string' ? value : String(value),
        prefix,
        suffix,
        el.selectionStart,
        el.selectionEnd
      );
      
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      nativeInputValueSetter?.call(el, newValue);
      const event = new Event('input', { bubbles: true });
      el.dispatchEvent(event);

      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(newSelectionStart, newSelectionEnd);
      });
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        if (e.key === 'b') {
          e.preventDefault();
          applyFormat('**', '**');
        } else if (e.key === 'i') {
          e.preventDefault();
          applyFormat('_', '_');
        } else if (e.key === 'k') {
          e.preventDefault();
          applyFormat('[', '](url)');
        }
      }
      if (onKeyDown) onKeyDown(e);
    };

    return (
      <div className={`cf-markdown-editor flex flex-col space-y-2 ${className}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2" role="tablist" aria-label="Markdown editor tabs">
            <Btn
              type="button"
              role="tab"
              aria-selected={tab === 'write'}
              ghost={tab !== 'write'}
              onClick={() => setTab('write')}
              className="cf-target-44 min-w-[80px]"
            >
              Write
            </Btn>
            <Btn
              type="button"
              role="tab"
              aria-selected={tab === 'preview'}
              ghost={tab !== 'preview'}
              onClick={() => setTab('preview')}
              className="cf-target-44 min-w-[80px]"
            >
              Preview
            </Btn>
          </div>
          {showToolbar && tab === 'write' && (
            <div className="flex gap-1 items-center bg-[var(--color-neutral-800)] p-1 rounded-md max-w-full overflow-x-auto flex-wrap" role="toolbar" aria-label="Markdown formatting">
              <Btn type="button" unstyled className="cf-target-44 px-3 py-2 hover:bg-[var(--color-neutral-700)] rounded" onClick={() => applyFormat('**', '**')} title="Bold (Ctrl+B)" aria-label="Bold"><span className="font-bold">B</span></Btn>
              <Btn type="button" unstyled className="cf-target-44 px-3 py-2 hover:bg-[var(--color-neutral-700)] rounded" onClick={() => applyFormat('_', '_')} title="Italic (Ctrl+I)" aria-label="Italic"><span className="italic">I</span></Btn>
              <Btn type="button" unstyled className="cf-target-44 px-3 py-2 hover:bg-[var(--color-neutral-700)] rounded" onClick={() => applyFormat('[', '](url)')} title="Link (Ctrl+K)" aria-label="Link">🔗</Btn>
              <Btn type="button" unstyled className="cf-target-44 px-3 py-2 hover:bg-[var(--color-neutral-700)] rounded" onClick={() => applyFormat('### ', '')} title="Heading" aria-label="Heading">H</Btn>
              <Btn type="button" unstyled className="cf-target-44 px-3 py-2 hover:bg-[var(--color-neutral-700)] rounded" onClick={() => applyFormat('- ', '')} title="List" aria-label="List">☰</Btn>
              <Btn type="button" unstyled className="cf-target-44 px-3 py-2 hover:bg-[var(--color-neutral-700)] rounded" onClick={() => applyFormat('`', '`')} title="Code" aria-label="Code">{'<>'}</Btn>
            </div>
          )}
          <span className="text-xs text-[var(--color-neutral-400)] ml-auto cursor-help" title="**bold** _italic_ [link](url) # header - list `code`">
            Markdown help
          </span>
        </div>

        <div className="relative min-w-0">
          <div style={{ display: tab === 'write' ? 'block' : 'none' }}>
            <TextArea
              ref={textareaRef}
              value={value}
              onChange={onChange}
              onKeyDown={handleKeyDown}
              className="w-full"
              {...props}
            />
          </div>
          {tab === 'preview' && (
            <Card data-testid="markdown-preview" className="min-h-[120px] max-h-[500px] overflow-auto">
              {value ? <Markdown>{String(value)}</Markdown> : <span className="text-[var(--color-neutral-500)] italic">Nothing to preview.</span>}
            </Card>
          )}
        </div>
      </div>
    );
  }
);
