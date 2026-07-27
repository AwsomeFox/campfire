import { useState } from 'react';

type PrintControlProps = {
  /** Only DMs can choose to add secret content to a paper copy. */
  allowSecrets?: boolean;
  className?: string;
};

/** A deliberately local print preference: it never survives a page unmount. */
export function PrintControl({ allowSecrets = false, className = '' }: PrintControlProps) {
  const [includeSecrets, setIncludeSecrets] = useState(false);

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
        onClick={() => {
          document.documentElement.classList.toggle('cf-print-include-secrets', includeSecrets);
          window.print();
          document.documentElement.classList.remove('cf-print-include-secrets');
        }}
      >
        Print / Save PDF
      </button>
    </div>
  );
}
