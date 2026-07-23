import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import {
  backupDatabase,
  databaseName,
  filenamePart,
  formatBytes,
  parseArgs,
  pgDumpFailure,
  redact,
} from '../../scripts/backup-db';

const databaseUrl = 'postgresql://backup-user:p%40ssword@db.example/meetpr_prod';
const now = new Date('2026-07-23T12:34:56.000Z');
const outputName = 'meetpr-production-2026-07-23T123456.000Z.sql.gz';
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meetpr-backup-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('backup-db helpers', () => {
  it('formats byte boundaries', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(10 * 1024)).toBe('10 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB');
  });

  it('redacts both DATABASE_URL and its decoded password', () => {
    const result = redact(`failed for ${databaseUrl}; password=p@ssword`, databaseUrl);

    expect(result).toContain('[DATABASE_URL]');
    expect(result).toContain('password=[REDACTED]');
    expect(result).not.toContain(databaseUrl);
    expect(result).not.toContain('p@ssword');
  });

  it('parses database and filename components without leaking URL syntax', () => {
    expect(databaseName(databaseUrl)).toBe('meetpr_prod');
    expect(filenamePart(' Production / EU-West ')).toBe('production-eu-west');
    expect(filenamePart('---')).toBe('database');
    expect(() => databaseName('not a url')).toThrow('valid PostgreSQL URL');
    expect(() => databaseName('postgresql://db.example')).toThrow('must include a database name');
  });

  it('parses output arguments and rejects missing or unknown values', () => {
    expect(parseArgs([])).toEqual({ help: false, outDir: './backups' });
    expect(parseArgs(['--out-dir', '/tmp/safe'])).toEqual({
      help: false,
      outDir: '/tmp/safe',
    });
    expect(parseArgs(['--out-dir=/tmp/safe', '--help'])).toEqual({
      help: true,
      outDir: '/tmp/safe',
    });
    expect(() => parseArgs(['--out-dir'])).toThrow('--out-dir requires');
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument');
  });

  it('distinguishes pg_dump ENOENT, exit-code, signal, and success outcomes', () => {
    const missingBinary = Object.assign(new Error('spawn pg_dump ENOENT'), {
      code: 'ENOENT',
    });
    expect(
      pgDumpFailure({ code: null, signal: null, spawnError: missingBinary }, '', databaseUrl)
        ?.message,
    ).toContain('not found in PATH');

    const exited = pgDumpFailure(
      { code: 2, signal: null },
      `connection failed: ${databaseUrl} p@ssword`,
      databaseUrl,
    );
    expect(exited?.message).toContain('exit code 2');
    expect(exited?.message).not.toContain(databaseUrl);
    expect(exited?.message).not.toContain('p@ssword');

    expect(pgDumpFailure({ code: null, signal: 'SIGTERM' }, '', databaseUrl)?.message).toContain(
      'signal SIGTERM',
    );
    expect(pgDumpFailure({ code: 0, signal: null }, '', databaseUrl)).toBeNull();
  });
});

describe('backupDatabase publication', () => {
  it('publishes a completed partial archive with its final size', async () => {
    const outDir = await makeTemporaryDirectory();
    const result = await backupDatabase(
      { databaseUrl, environment: 'production', now, outDir },
      {
        partialSuffix: () => 'success',
        dumpToFile: async (_url, partialPath) => {
          await writeFile(partialPath, 'complete archive', { mode: 0o600 });
        },
      },
    );

    expect(result).toEqual({
      path: path.join(outDir, outputName),
      sizeBytes: Buffer.byteLength('complete archive'),
    });
    expect(await readFile(result.path, 'utf8')).toBe('complete archive');
    expect((await readdir(outDir)).filter((name) => name.endsWith('.partial'))).toEqual([]);
  });

  it('removes only its own partial on failure and preserves unrelated backups', async () => {
    const outDir = await makeTemporaryDirectory();
    const existingPath = path.join(outDir, 'existing.sql.gz');
    await writeFile(existingPath, 'keep me');

    await expect(
      backupDatabase(
        { databaseUrl, environment: 'production', now, outDir },
        {
          partialSuffix: () => 'owned',
          dumpToFile: async (_url, partialPath) => {
            await writeFile(partialPath, 'incomplete');
            throw new Error('simulated pg_dump failure');
          },
        },
      ),
    ).rejects.toThrow('simulated pg_dump failure');

    expect(await readFile(existingPath, 'utf8')).toBe('keep me');
    expect(await readdir(outDir)).toEqual(['existing.sql.gz']);
  });

  it('refuses to overwrite or delete an existing final output', async () => {
    const outDir = await makeTemporaryDirectory();
    const outputPath = path.join(outDir, outputName);
    await writeFile(outputPath, 'reviewed backup');
    let dumpStarted = false;

    await expect(
      backupDatabase(
        { databaseUrl, environment: 'production', now, outDir },
        {
          partialSuffix: () => 'unused',
          dumpToFile: () => {
            dumpStarted = true;
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow('Backup output already exists; refusing to overwrite');

    expect(dumpStarted).toBe(false);
    expect(await readFile(outputPath, 'utf8')).toBe('reviewed backup');
    expect(await readdir(outDir)).toEqual([outputName]);
  });

  it('atomically refuses an output that appears before publication', async () => {
    const outDir = await makeTemporaryDirectory();
    const outputPath = path.join(outDir, outputName);
    const partialName = `${outputName}.${String(process.pid)}-racing.partial`;

    await expect(
      backupDatabase(
        { databaseUrl, environment: 'production', now, outDir },
        {
          partialSuffix: () => 'racing',
          dumpToFile: async (_url, partialPath) => {
            await writeFile(partialPath, 'our completed archive');
            await writeFile(outputPath, 'concurrent backup');
          },
        },
      ),
    ).rejects.toThrow('Backup output already exists; refusing to overwrite');

    expect(await readFile(outputPath, 'utf8')).toBe('concurrent backup');
    expect(await readdir(outDir)).not.toContain(partialName);
    expect(await readdir(outDir)).toEqual([outputName]);
  });
});
