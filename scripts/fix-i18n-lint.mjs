#!/usr/bin/env node
/**
 * One-shot cleanup for issue #629 — remove erroneous hooks in helpers and fix lint.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** @param {string} file */
function fixFile(file) {
  let src = readFileSync(file, 'utf8');
  const orig = src;

  // Drop `const { t } = useTranslation();` when it immediately follows a non-export function declaration.
  src = src.replace(
    /(\nfunction \w+[^{]*\{)\n\s*const \{ t \} = useTranslation\(\);\n/g,
    '$1\n',
  );

  // Unused ApiError in import — keep translateApiError when present.
  src = src.replace(
    /import \{([^}]*)\} from ['"]\.\.\/\.\.\/lib\/api['"];/g,
    (m, inner) => {
      const parts = inner.split(',').map((p) => p.trim()).filter(Boolean);
      const filtered = parts.filter((p) => !/\bApiError\b/.test(p));
      if (filtered.length === parts.length) return m;
      return `import { ${filtered.join(', ')} } from '../../lib/api';`;
    },
  );

  // Unused translateApiError when only translateApiError was imported alongside api.
  if (!src.includes('translateApiError(')) {
    src = src.replace(
      /import \{([^}]*)\} from ['"]\.\.\/\.\.\/lib\/api['"];/g,
      (m, inner) => {
        const parts = inner.split(',').map((p) => p.trim()).filter(Boolean);
        const filtered = parts.filter((p) => !/\btranslateApiError\b/.test(p));
        if (filtered.length === parts.length) return m;
        return `import { ${filtered.join(', ')} } from '../../lib/api';`;
      },
    );
  }

  // Rename unused `const { t }` → `_t` in files that still don't reference `t(`.
  if (src.includes('const { t } = useTranslation()') && !/\bt\(/.test(src)) {
    src = src.replace(/const \{ t \} = useTranslation\(\)/g, 'const { t: _t } = useTranslation()');
  }

  if (src !== orig) {
    writeFileSync(file, src);
    return true;
  }
  return false;
}

const files = [
  'apps/web/src/features/admin/ActorRoleBadge.tsx',
  'apps/web/src/features/admin/AdminAiPage.tsx',
  'apps/web/src/features/admin/AdminAuditPage.tsx',
  'apps/web/src/features/admin/AdminAuthPage.tsx',
  'apps/web/src/features/admin/AdminPage.tsx',
  'apps/web/src/features/admin/AdminRulesPage.tsx',
  'apps/web/src/features/admin/AdminStoragePage.tsx',
  'apps/web/src/features/admin/AdminUsersPage.tsx',
  'apps/web/src/features/admin/AiConsoleCard.tsx',
  'apps/web/src/features/admin/AuditLogCard.tsx',
  'apps/web/src/features/admin/BackupCard.tsx',
  'apps/web/src/features/admin/InviteQrCard.tsx',
  'apps/web/src/features/admin/MembersPage.tsx',
  'apps/web/src/features/admin/MembershipIntegrityCard.tsx',
  'apps/web/src/features/admin/MetricsCard.tsx',
  'apps/web/src/features/admin/OidcCard.tsx',
  'apps/web/src/features/admin/RequireServerAdmin.tsx',
  'apps/web/src/features/admin/ResetRequestsCard.tsx',
  'apps/web/src/features/admin/ServerBackupWorkflowCard.tsx',
  'apps/web/src/features/admin/SettingsCard.tsx',
  'apps/web/src/features/admin/StorageCard.tsx',
  'apps/web/src/features/admin/TokensCard.tsx',
  'apps/web/src/features/admin/TokensPage.tsx',
  'apps/web/src/features/compendium/CompendiumPage.tsx',
  'apps/web/src/features/compendium/ReaderPage.tsx',
  'apps/web/src/features/encounters/ActionUseFlow.tsx',
  'apps/web/src/features/encounters/CheckRequests.tsx',
  'apps/web/src/features/encounters/EncounterListPage.tsx',
  'apps/web/src/features/encounters/GenerateEncounterWizard.tsx',
  'apps/web/src/features/encounters/TurnWorkspace.tsx',
  'apps/web/src/features/inventory/InventoryPage.tsx',
  'apps/web/src/features/session-zero/SessionZeroPage.tsx',
  'apps/web/src/features/sessions/RsvpChooser.tsx',
  'apps/web/src/features/sessions/SchedulePanel.tsx',
  'apps/web/src/features/sessions/ScribePanel.tsx',
  'apps/web/src/features/sessions/SessionsPage.tsx',
  'apps/web/src/features/sessions/SharedRecapPage.tsx',
];

let n = 0;
for (const f of files) {
  if (fixFile(f)) n += 1;
}
console.log(`fix-i18n-lint: updated ${n} file(s)`);
