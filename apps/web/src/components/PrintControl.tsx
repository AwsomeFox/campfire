import { useEffect, useState } from 'react';

type PrintControlProps = {
  /** Only DMs can choose to add secret content to a paper copy. */
  allowSecrets?: boolean;
  className?: string;
  /**
   * Identity of the entity being printed. When it changes (same route, new id),
   * the secrets opt-in resets so the choice never carries across reference pages.
   */
  resetKey?: string | number;
};

/** A deliberately local print preference: it never survives a page unmount. */
export function PrintControl({ allowSecrets = false, className = '', resetKey }: PrintControlProps) {
  const [includeSecrets, setIncludeSecrets] = useState(false);

  // Route components are reused when only :id changes, so reset explicitly.
  useEffect(() => {
    setIncludeSecrets(false);
  }, [resetKey]);

  // Keep the root marker in sync while the page is mounted. This makes Ctrl/Cmd+P
  // honor an explicit choice too; cleanup makes the preference navigation-local.
  useEffect(() => {
    document.documentElement.classList.toggle('cf-print-include-secrets', includeSecrets && allowSecrets);
    return () => document.documentElement.classList.remove('cf-print-include-secrets');
  }, [allowSecrets, includeSecrets]);

  return (
    <div className={`cf-print-hide flex items-center gap-2 ${className}`}>
      {allowSecrets && (
        <label className="flex items-center gap-1.5 text-xs text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={includeSecrets}
            onChange={(event) => setIncludeSecrets(event.target.checked)}
            aria-label="Include DM secrets"
          />
          Include DM secrets
        </label>
      )}
      <button
        type="button"
        className="cf-btn cf-btn-ghost cf-density-compact text-xs"
        onClick={() => window.print()}
      >
        Print / Save PDF
      </button>
    </div>
  );
}
