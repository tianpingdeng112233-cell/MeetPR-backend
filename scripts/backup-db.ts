import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

import { z } from 'zod';

const DEFAULT_OUT_DIR = './backups';
const STDERR_LIMIT_BYTES = 32 * 1024;

const BackupEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.string().trim().min(1).optional(),
});

export interface BackupCliOptions {
  help: boolean;
  outDir: string;
}

export interface BackupOptions {
  databaseUrl: string;
  environment?: string;
  now?: Date;
  outDir?: string;
}

export interface BackupResult {
  path: string;
  sizeBytes: number;
}

export interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

type DumpToFile = (databaseUrl: string, partialPath: string) => Promise<void>;

export interface BackupRuntime {
  dumpToFile?: DumpToFile;
  partialSuffix?: () => string;
}

const HELP = `Usage: pnpm tsx scripts/backup-db.ts [--out-dir <directory>]

Create a gzip-compressed full logical backup of DATABASE_URL with pg_dump.

Options:
  --out-dir <directory>  Output directory (default: ./backups)
  -h, --help             Show this help
`;

export function parseArgs(args: string[]): BackupCliOptions {
  let outDir = DEFAULT_OUT_DIR;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--out-dir') {
      const value = args[index + 1];
      if (value === undefined || value.trim().length === 0) {
        throw new Error('--out-dir requires a directory');
      }
      outDir = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--out-dir=')) {
      const value = argument.slice('--out-dir='.length);
      if (value.trim().length === 0) {
        throw new Error('--out-dir requires a directory');
      }
      outDir = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`);
  }

  return { help, outDir };
}

export function databaseName(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }

  const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).split('/').at(-1);
  if (name === undefined || name.length === 0) {
    throw new Error('DATABASE_URL must include a database name');
  }
  return name;
}

export function filenamePart(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');

  return sanitized || 'database';
}

function waitForChild(child: ChildProcess): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    child.once('error', (error: Error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    });
  });
}

function collectStderr(child: ChildProcess): () => string {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string | Buffer) => {
    if (Buffer.byteLength(stderr) >= STDERR_LIMIT_BYTES) return;
    stderr += chunk.toString();
  });
  return () => stderr.trim();
}

export function redact(message: string, databaseUrl: string): string {
  let redacted = message.replaceAll(databaseUrl, '[DATABASE_URL]');
  try {
    const password = decodeURIComponent(new URL(databaseUrl).password);
    if (password.length > 0) {
      redacted = redacted.replaceAll(password, '[REDACTED]');
    }
  } catch {
    // URL validation happens before pg_dump starts; keep this fallback defensive.
  }
  return redacted;
}

export function pgDumpFailure(
  outcome: ChildOutcome,
  stderr: string,
  databaseUrl: string,
): Error | null {
  if (outcome.spawnError !== undefined) {
    const nodeError = outcome.spawnError as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return new Error('pg_dump was not found in PATH; install PostgreSQL client tools');
    }
    return new Error(`Could not start pg_dump: ${redact(outcome.spawnError.message, databaseUrl)}`);
  }
  if (outcome.code === 0) return null;

  const status =
    outcome.signal === null
      ? `exit code ${String(outcome.code)}`
      : `signal ${String(outcome.signal)}`;
  const detail = stderr.length === 0 ? '' : `: ${redact(stderr, databaseUrl)}`;
  return new Error(`pg_dump failed with ${status}${detail}`);
}

export function formatBytes(sizeBytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export interface SplitConnection {
  url: string;
  password?: string;
}

export function splitPassword(databaseUrl: string): SplitConnection {
  const parsed = new URL(databaseUrl);
  const password = decodeURIComponent(parsed.password);
  if (password.length === 0) return { url: databaseUrl };
  parsed.password = '';
  return { url: parsed.toString(), password };
}

export async function dumpToFile(databaseUrl: string, partialPath: string): Promise<void> {
  // libpq only expands postgres:// URIs in the dbname argument, not PGDATABASE.
  // The password rides in PGPASSWORD so it never appears in the process argv.
  const connection = splitPassword(databaseUrl);
  const pgDump = spawn('pg_dump', ['--format=plain', connection.url], {
    env: {
      ...process.env,
      PGAPPNAME: 'meetpr-backup-db',
      ...(connection.password === undefined ? {} : { PGPASSWORD: connection.password }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const readStderr = collectStderr(pgDump);
  const childOutcomePromise = waitForChild(pgDump);

  let streamError: unknown;
  try {
    await pipeline(
      pgDump.stdout!,
      createGzip(),
      createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error: unknown) {
    streamError = error;
  }

  const childOutcome = await childOutcomePromise;
  const dumpError = pgDumpFailure(childOutcome, readStderr(), databaseUrl);
  if (dumpError !== null) throw dumpError;
  if (streamError !== undefined) {
    const message = streamError instanceof Error ? streamError.message : String(streamError);
    throw new Error(`Could not write backup archive: ${redact(message, databaseUrl)}`);
  }
}

async function assertOutputDoesNotExist(outputPath: string): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Backup output already exists; refusing to overwrite: ${outputPath}`);
}

async function publishWithoutOverwrite(partialPath: string, outputPath: string): Promise<void> {
  try {
    await link(partialPath, outputPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Backup output already exists; refusing to overwrite: ${outputPath}`);
    }
    throw error;
  }
  await unlink(partialPath);
}

export async function backupDatabase(
  options: BackupOptions,
  runtime: BackupRuntime = {},
): Promise<BackupResult> {
  const environment = filenamePart(
    options.environment?.trim() || databaseName(options.databaseUrl),
  );
  const timestamp = (options.now ?? new Date()).toISOString().replaceAll(':', '');
  const outDir = path.resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const outputPath = path.join(outDir, `meetpr-${environment}-${timestamp}.sql.gz`);

  await mkdir(outDir, { recursive: true });
  await assertOutputDoesNotExist(outputPath);

  const suffix = runtime.partialSuffix?.() ?? randomUUID();
  const partialPath = `${outputPath}.${String(process.pid)}-${suffix}.partial`;
  let published = false;

  try {
    await (runtime.dumpToFile ?? dumpToFile)(options.databaseUrl, partialPath);
    const archiveStat = await stat(partialPath);
    if (!archiveStat.isFile()) {
      throw new Error('Could not publish backup archive: partial output is not a file');
    }

    await publishWithoutOverwrite(partialPath, outputPath);
    published = true;

    // TODO(OSS): upload the completed local archive here, after pg_dump and gzip succeed.
    return { path: outputPath, sizeBytes: archiveStat.size };
  } finally {
    if (!published) {
      await rm(partialPath, { force: true });
    }
  }
}

async function main(): Promise<void> {
  try {
    const cli = parseArgs(process.argv.slice(2));
    if (cli.help) {
      console.log(HELP);
      return;
    }

    const environment = BackupEnvironmentSchema.safeParse(process.env);
    if (!environment.success) {
      throw new Error('DATABASE_URL is required');
    }

    const result = await backupDatabase({
      databaseUrl: environment.data.DATABASE_URL,
      ...(environment.data.NODE_ENV === undefined
        ? {}
        : { environment: environment.data.NODE_ENV }),
      outDir: cli.outDir,
    });
    console.log(`Backup created: ${result.path}`);
    console.log(`Backup size: ${formatBytes(result.sizeBytes)}`);
  } catch (error: unknown) {
    console.error(
      `DATABASE_BACKUP_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
