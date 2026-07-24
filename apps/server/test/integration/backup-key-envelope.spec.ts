import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { DbHolder, type DrizzleDb } from '../../src/db/db.module';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { BackupService, RESTORE_CONFIRM_TOKEN } from '../../src/modules/backup/backup.service';
import { AiProviderConfigService } from '../../src/modules/ai-provider-config/ai-provider-config.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';
import { KEY_ENVELOPE_ENTRY } from '../../src/modules/backup/backup-key-envelope';
import type { BackupManifest } from '../../src/modules/backup/backup-manifest';
import type { RequestUser } from '../../src/common/user.types';
import { encryptSecret, decryptSecret } from '../../src/common/crypto';
import { aiProviderConfigs } from '../../src/db/schema';

/**
 * #496: End-to-end coverage of the passphrase-encrypted AI keyfile envelope.
 * The unit tests pin the envelope math; this suite pins the archive posture
 * ("does buildBackup ACTUALLY include the envelope when I ask for it?") and
 * the restore behavior against a real BackupService wired to real DB
 * fixtures — matching the shape of backup-catchup.spec (no Nest bootstrap).
 */

const PASSPHRASE = 'correct-horse-battery-staple';

// Minimal RequestUser shape sufficient for BackupService.restore's audit call.
const testUser: RequestUser = {
  id: '1',
  name: 'admin',
  serverRole: 'admin',
};

describe('BackupService AI keyfile envelope (#496, real SQLite)', () => {
  let dataDir: string;
  let holder: DbHolder;
  let prevDataDir: string | undefined;
  let prevEnvKey: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.DATA_DIR;
    prevEnvKey = process.env.AI_CONFIG_KEY;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-envtest-'));
    process.env.DATA_DIR = dataDir;
    // Ensure the "keyfile" branch — no env-managed key.
    delete process.env.AI_CONFIG_KEY;
    // Write a plausible auto-generated keyfile so buildBackup has something to
    // wrap. In production the ai-provider-config service creates this on first
    // access; here we short-circuit the setup so the test does not need to
    // spin up that service.
    fs.writeFileSync(
      path.join(dataDir, 'ai-config.key'),
      'deadbeef'.repeat(8), // 64-hex, matches production keyfile shape
      { mode: 0o600 },
    );
    holder = new DbHolder();
  });

  afterEach(() => {
    holder?.onApplicationShutdown();
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    if (prevEnvKey === undefined) delete process.env.AI_CONFIG_KEY;
    else process.env.AI_CONFIG_KEY = prevEnvKey;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function makeService(): BackupService {
    const db = holder.proxy as DrizzleDb;
    const audit = new AuditService(db);
    const aiProviderConfig = { invalidateCachedKey: jest.fn() } as unknown as AiProviderConfigService;
    return new BackupService(
      holder,
      db,
      audit,
      new SettingsService(db),
      new AttachmentsService(db, audit, new FsDeletionService(db, audit)),
      aiProviderConfig,
    );
  }

  async function manifestFromArchive(buffer: Buffer): Promise<BackupManifest> {
    const zip = await JSZip.loadAsync(buffer);
    const text = await zip.file('manifest.json')!.async('string');
    return JSON.parse(text) as BackupManifest;
  }

  it('records aiKeySource=keyfile when the running server uses the auto-generated keyfile', async () => {
    const service = makeService();
    const buffer = await service.buildBackup();
    const manifest = await manifestFromArchive(buffer);
    expect(manifest.aiKeySource).toBe('keyfile');
    expect(manifest.aiKeyIncluded).toBe(false);
    expect(manifest.version).toBe(1);
    // No envelope entry when no passphrase was supplied.
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file(KEY_ENVELOPE_ENTRY)).toBeNull();
  });

  it('records aiKeySource=env when AI_CONFIG_KEY is set on the host', async () => {
    process.env.AI_CONFIG_KEY = 'a'.repeat(64); // 64-hex → raw key
    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });
    const manifest = await manifestFromArchive(buffer);
    expect(manifest.aiKeySource).toBe('env');
    // Env-managed → envelope is NOT included even when a passphrase is passed
    // (the operator asserts external key management).
    expect(manifest.aiKeyIncluded).toBe(false);
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file(KEY_ENVELOPE_ENTRY)).toBeNull();
  });

  it('includes an encrypted keyfile envelope when a passphrase is supplied', async () => {
    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });
    const manifest = await manifestFromArchive(buffer);
    expect(manifest.aiKeySource).toBe('keyfile');
    expect(manifest.aiKeyIncluded).toBe(true);
    expect(manifest.version).toBe(2);
    const zip = await JSZip.loadAsync(buffer);
    const entry = zip.file(KEY_ENVELOPE_ENTRY);
    expect(entry).not.toBeNull();
    // The envelope must be JSON and must NOT contain the plaintext keyfile.
    const envText = await entry!.async('string');
    const parsed = JSON.parse(envText);
    expect(parsed.kdf).toBe('scrypt');
    expect(parsed.v).toBe(1);
    expect(typeof parsed.ct).toBe('string');
    // The raw keyfile ("deadbeef" repeats 8 times = "deadbeef..." run) must
    // not appear anywhere in the envelope's serialized form.
    expect(envText).not.toContain('deadbeef');
  });

  it('rejects a short passphrase before building the archive', async () => {
    const service = makeService();
    await expect(service.buildBackup({ keyPassphrase: 'short' })).rejects.toThrow(
      /at least 12 characters/,
    );
  });

  it('restores from an envelope-carrying archive and rewrites the keyfile', async () => {
    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });

    // Wipe the local keyfile so the restore's write is observable.
    fs.rmSync(path.join(dataDir, 'ai-config.key'), { force: true });
    expect(fs.existsSync(path.join(dataDir, 'ai-config.key'))).toBe(false);

    const result = await service.restore(buffer, RESTORE_CONFIRM_TOKEN, testUser, {
      keyPassphrase: PASSPHRASE,
    });
    expect(result.ok).toBe(true);
    // Keyfile is back with the original content.
    const restored = fs.readFileSync(path.join(dataDir, 'ai-config.key'), 'utf8').trim();
    expect(restored).toBe('deadbeef'.repeat(8));
    // AND it has restrictive permissions (0600). On some CI filesystems the
    // mode bits are masked; we assert the full owner read/write triple and
    // confirm group/world bits are clear.
    const mode = fs.statSync(path.join(dataDir, 'ai-config.key')).mode & 0o777;
    expect(mode & 0o600).toBe(0o600);
    expect(mode & 0o077).toBe(0);
  });

  it('rejects a restore that omits the passphrase when the archive has an envelope', async () => {
    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });

    await expect(
      service.restore(buffer, RESTORE_CONFIRM_TOKEN, testUser /* no options */),
    ).rejects.toThrow(/keyPassphrase/);

    // Keyfile stays untouched (server not restored).
    expect(fs.readFileSync(path.join(dataDir, 'ai-config.key'), 'utf8').trim()).toBe(
      'deadbeef'.repeat(8),
    );
  });

  it('rejects a restore with the wrong passphrase without touching the live DB', async () => {
    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });

    // Overwrite the keyfile with a marker so we can prove the restore did NOT
    // run when the passphrase was wrong.
    fs.writeFileSync(path.join(dataDir, 'ai-config.key'), 'marker', { mode: 0o600 });

    await expect(
      service.restore(buffer, RESTORE_CONFIRM_TOKEN, testUser, { keyPassphrase: 'wrong-wrong-wrong' }),
    ).rejects.toThrow(/passphrase is wrong|failed to decrypt/i);

    expect(fs.readFileSync(path.join(dataDir, 'ai-config.key'), 'utf8')).toBe('marker');
  });

  it('does not write the archive keyfile onto a host running with AI_CONFIG_KEY', async () => {
    // Build the archive under the keyfile posture...
    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });

    // ...then simulate restoring on a DIFFERENT host that uses env-managed key.
    fs.rmSync(path.join(dataDir, 'ai-config.key'), { force: true });
    // Use the SAME key material as the archive keyfile so the env-key validation
    // passes (archive has no ai_provider_configs rows, so the check is a no-op).
    process.env.AI_CONFIG_KEY = 'b'.repeat(64);

    await service.restore(buffer, RESTORE_CONFIRM_TOKEN, testUser, { keyPassphrase: PASSPHRASE });

    // The archive's keyfile should NOT be materialized — the env var takes
    // precedence and the local keyfile would just be a source of drift.
    expect(fs.existsSync(path.join(dataDir, 'ai-config.key'))).toBe(false);
  });

  it('rejects restore when AI_CONFIG_KEY is set but does not match the archive credentials', async () => {
    // Insert a credential encrypted with the archive keyfile ('deadbeef' * 8).
    const archiveKey = Buffer.from('deadbeef'.repeat(8), 'hex');
    const encrypted = encryptSecret('sk-test-secret', archiveKey);
    const db = holder.proxy as DrizzleDb;
    const now = new Date().toISOString();
    await db.insert(aiProviderConfigs).values({
      scope: 'server',
      providerType: 'openai',
      model: 'gpt-4',
      params: '{}',
      encryptedApiKey: encrypted,
      keyLast4: 'ecre',
      allowedModels: '[]',
      createdBy: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });

    // Now switch to a DIFFERENT env key on the "restore host".
    process.env.AI_CONFIG_KEY = 'c'.repeat(64); // Different from archive key
    fs.rmSync(path.join(dataDir, 'ai-config.key'), { force: true });

    await expect(
      service.restore(buffer, RESTORE_CONFIRM_TOKEN, testUser, { keyPassphrase: PASSPHRASE }),
    ).rejects.toThrow(/AI_CONFIG_KEY on this host does not match/i);

    // Server untouched — keyfile not written.
    expect(fs.existsSync(path.join(dataDir, 'ai-config.key'))).toBe(false);
  });

  it('inspect() reports the AI-key posture without decrypting anything', async () => {
    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });

    const view = await service.inspect(buffer);
    expect(view.aiKeySource).toBe('keyfile');
    expect(view.aiKeyIncluded).toBe(true);
    // credentialCount is 0 (no provider rows in the fresh fixture DB), but the
    // field is present as a number so the UI can render "N credentials
    // depend on this key" copy.
    expect(typeof view.aiCredentialCount === 'number' || view.aiCredentialCount === null).toBe(true);
  });

  it('rejects restore when manifest claims an envelope but the entry is missing', async () => {
    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });
    const zip = await JSZip.loadAsync(buffer);
    zip.remove(KEY_ENVELOPE_ENTRY);
    const tampered = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(
      service.restore(tampered, RESTORE_CONFIRM_TOKEN, testUser, { keyPassphrase: PASSPHRASE }),
    ).rejects.toThrow(/manifest claims an AI key envelope/i);
  });

  it('restored keyfile decrypts stored provider credentials after envelope restore', async () => {
    const key = Buffer.from('deadbeef'.repeat(8), 'hex');
    const plaintext = 'sk-test-api-key-12345';
    const encrypted = encryptSecret(plaintext, key);
    const db = holder.proxy as DrizzleDb;
    const now = new Date().toISOString();
    await db.insert(aiProviderConfigs).values({
      scope: 'server',
      providerType: 'openai',
      model: 'gpt-4',
      params: '{}',
      encryptedApiKey: encrypted,
      keyLast4: '2345',
      allowedModels: '[]',
      createdBy: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    const service = makeService();
    const buffer = await service.buildBackup({ keyPassphrase: PASSPHRASE });
    fs.rmSync(path.join(dataDir, 'ai-config.key'), { force: true });

    const result = await service.restore(buffer, RESTORE_CONFIRM_TOKEN, testUser, { keyPassphrase: PASSPHRASE });
    expect(result.ok).toBe(true);

    const restoredKey = Buffer.from(fs.readFileSync(path.join(dataDir, 'ai-config.key'), 'utf8').trim(), 'hex');
    const rows = await db.select().from(aiProviderConfigs);
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0].encryptedApiKey!, restoredKey)).toBe(plaintext);
  });
});
