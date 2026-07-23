import { z } from 'zod';
import type { PoolClient } from 'pg';

import { createPool } from '../src/db/pool';
import { backupDatabase, formatBytes } from './backup-db';

const TEST_PHONE_PATTERN = /^\+861(?:380000000|390000004)\d$/;
const TEST_UUID_PATTERN = /^00000000-0000-0000-0000-0000000000[0-9a-f]{2}$/i;

const DeleteEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.string().trim().min(1).optional(),
});

export interface CliOptions {
  apply: boolean;
  help: boolean;
  ids: string[];
}

export interface UserRow {
  id: string;
  phone: string;
  is_test: boolean;
}

interface ForeignKeyRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  delete_action: string;
}

interface ForeignKeyGroup {
  schemaName: string;
  tableName: string;
  columns: string[];
  deleteActions: Set<string>;
}

const HELP = `Usage: pnpm tsx scripts/delete-test-accounts.ts [--apply --id <uuid> ...]

Preview or delete accounts protected by both users.is_test and the test phone/UUID allowlist.
The default mode is dry-run. It prints a copyable apply command bound to the reviewed IDs.
--apply requires one or more --id values and first creates a full database backup.

Options:
  --apply       Create a backup, then delete only the supplied allowlisted IDs
  --id <uuid>   Reviewed account ID to delete (repeat for multiple accounts)
  -h, --help    Show this help
`;

const FOREIGN_KEYS_SQL = `
  SELECT
    child_namespace.nspname AS schema_name,
    child_table.relname AS table_name,
    child_column.attname AS column_name,
    CASE constraint_row.confdeltype
      WHEN 'a' THEN 'no action'
      WHEN 'r' THEN 'restrict'
      WHEN 'c' THEN 'cascade'
      WHEN 'n' THEN 'set null'
      WHEN 'd' THEN 'set default'
      ELSE constraint_row.confdeltype::text
    END AS delete_action
  FROM pg_constraint AS constraint_row
  JOIN pg_class AS parent_table
    ON parent_table.oid = constraint_row.confrelid
  JOIN pg_namespace AS parent_namespace
    ON parent_namespace.oid = parent_table.relnamespace
  JOIN pg_class AS child_table
    ON child_table.oid = constraint_row.conrelid
  JOIN pg_namespace AS child_namespace
    ON child_namespace.oid = child_table.relnamespace
  CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY
    AS child_key(attnum, position)
  JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY
    AS parent_key(attnum, position)
    ON parent_key.position = child_key.position
  JOIN pg_attribute AS child_column
    ON child_column.attrelid = child_table.oid
    AND child_column.attnum = child_key.attnum
  JOIN pg_attribute AS parent_column
    ON parent_column.attrelid = parent_table.oid
    AND parent_column.attnum = parent_key.attnum
  WHERE constraint_row.contype = 'f'
    AND parent_namespace.nspname = 'public'
    AND parent_table.relname = 'users'
    AND parent_column.attname = 'id'
    AND child_namespace.nspname = 'public'
  ORDER BY child_table.relname, child_column.attname
`;

function parseId(value: string | undefined): string {
  if (value === undefined || value.startsWith('-')) {
    throw new Error('--id requires a UUID');
  }
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid --id UUID: ${value}`);
  }
  return parsed.data.toLowerCase();
}

export function parseArgs(args: string[]): CliOptions {
  let apply = false;
  let help = false;
  const ids: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--id') {
      ids.push(parseId(args[index + 1]));
      index += 1;
    } else if (argument?.startsWith('--id=')) {
      ids.push(parseId(argument.slice('--id='.length)));
    } else {
      throw new Error(`Unknown argument: ${argument ?? ''}`);
    }
  }

  if (!help && apply && ids.length === 0) {
    throw new Error('--apply requires at least one --id <uuid>');
  }
  if (!help && !apply && ids.length > 0) {
    throw new Error('--id can only be used with --apply');
  }

  return { apply, help, ids: [...new Set(ids)] };
}

export function isAllowlisted(user: UserRow): boolean {
  return user.is_test && (TEST_PHONE_PATTERN.test(user.phone) || TEST_UUID_PATTERN.test(user.id));
}

export interface ApplySelection {
  allowlisted: UserRow[];
  selected: UserRow[];
  skippedOutsideAllowlist: UserRow[];
  skippedWithoutId: UserRow[];
}

export function selectApplyCandidates(
  markedUsers: UserRow[],
  requestedIds: string[],
): ApplySelection {
  const allowlisted = markedUsers.filter(isAllowlisted);
  const skippedOutsideAllowlist = markedUsers.filter((user) => !isAllowlisted(user));
  const allowlistedIds = new Set(allowlisted.map((user) => user.id.toLowerCase()));
  const normalizedRequestedIds = requestedIds.map((id) => id.toLowerCase());
  const invalidIds = normalizedRequestedIds.filter((id) => !allowlistedIds.has(id));

  if (invalidIds.length > 0) {
    throw new Error(
      `Requested --id values are not currently allowlisted test accounts: ${invalidIds.join(', ')}`,
    );
  }

  const requestedIdSet = new Set(normalizedRequestedIds);
  return {
    allowlisted,
    selected: allowlisted.filter((user) => requestedIdSet.has(user.id.toLowerCase())),
    skippedOutsideAllowlist,
    skippedWithoutId: allowlisted.filter((user) => !requestedIdSet.has(user.id.toLowerCase())),
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function groupForeignKeys(rows: ForeignKeyRow[]): ForeignKeyGroup[] {
  const groups = new Map<string, ForeignKeyGroup>();

  for (const row of rows) {
    const key = `${row.schema_name}.${row.table_name}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        schemaName: row.schema_name,
        tableName: row.table_name,
        columns: [row.column_name],
        deleteActions: new Set([row.delete_action]),
      });
    } else {
      existing.columns.push(row.column_name);
      existing.deleteActions.add(row.delete_action);
    }
  }

  return [...groups.values()];
}

async function loadUsers(client: PoolClient, lockRows: boolean): Promise<UserRow[]> {
  const lockClause = lockRows ? ' FOR UPDATE' : '';
  const result = await client.query<UserRow>(
    `SELECT id::text, phone, is_test FROM public.users WHERE is_test = true ORDER BY phone, id${lockClause}`,
  );
  return result.rows;
}

async function printImpactCounts(
  client: PoolClient,
  users: UserRow[],
  foreignKeys: ForeignKeyGroup[],
): Promise<void> {
  console.log('Direct foreign-key impact counts:');
  for (const user of users) {
    console.log(`- ${user.id} (${user.phone})`);
    let affectedTables = 0;

    for (const foreignKey of foreignKeys) {
      const table = `${quoteIdentifier(foreignKey.schemaName)}.${quoteIdentifier(
        foreignKey.tableName,
      )}`;
      const predicate = foreignKey.columns
        .map((column) => `${quoteIdentifier(column)} = $1`)
        .join(' OR ');
      const result = await client.query<{ row_count: string }>(
        `SELECT count(*)::text AS row_count FROM ${table} WHERE ${predicate}`,
        [user.id],
      );
      const count = Number(result.rows[0]?.row_count ?? '0');
      if (count === 0) continue;

      affectedTables += 1;
      const actions = [...foreignKey.deleteActions].sort().join('/');
      console.log(`  ${foreignKey.tableName}: ${String(count)} (${actions})`);
    }

    if (affectedTables === 0) {
      console.log('  (no direct child rows)');
    }
  }
}

function printAccounts(label: string, users: UserRow[]): void {
  console.log(`${label}:`);
  if (users.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const user of users) {
    console.log(`  id=${user.id} phone=${user.phone} is_test=${String(user.is_test)}`);
  }
}

export function buildApplyCommand(users: UserRow[]): string | null {
  if (users.length === 0) return null;
  const idArguments = users.map((user) => `--id ${user.id}`).join(' ');
  return `pnpm tsx scripts/delete-test-accounts.ts --apply ${idArguments}`;
}

function printApplyCommand(users: UserRow[]): void {
  const command = buildApplyCommand(users);
  if (command === null) {
    console.log('Apply command: (no allowlisted candidates)');
    return;
  }
  console.log(`Apply command: ${command}`);
}

export async function inspectAndMaybeDelete(
  client: PoolClient,
  cli: CliOptions,
): Promise<UserRow[]> {
  let transactionStarted = false;

  try {
    if (cli.apply) {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query('SET LOCAL search_path TO public');
    }

    const markedUsers = await loadUsers(client, cli.apply);
    const dryRunCandidates = markedUsers.filter(isAllowlisted);
    const selection = cli.apply
      ? selectApplyCandidates(markedUsers, cli.ids)
      : {
          allowlisted: dryRunCandidates,
          selected: dryRunCandidates,
          skippedOutsideAllowlist: markedUsers.filter((user) => !isAllowlisted(user)),
          skippedWithoutId: [],
        };

    for (const user of selection.skippedOutsideAllowlist) {
      console.warn(
        `WARNING: skipped is_test=true row outside phone/UUID allowlist: id=${user.id} phone=${user.phone}`,
      );
    }

    printAccounts(
      cli.apply ? 'Accounts approved for deletion' : 'Accounts that would be deleted',
      selection.selected,
    );
    if (cli.apply && selection.skippedWithoutId.length > 0) {
      printAccounts(
        'Allowlisted accounts skipped because their --id was not supplied',
        selection.skippedWithoutId,
      );
    }

    const foreignKeyResult = await client.query<ForeignKeyRow>(FOREIGN_KEYS_SQL);
    await printImpactCounts(client, selection.selected, groupForeignKeys(foreignKeyResult.rows));

    if (!cli.apply) {
      printApplyCommand(selection.selected);
      return [];
    }

    const deleteResult = await client.query<UserRow>(
      `
        DELETE FROM public.users
        WHERE id = ANY($1::uuid[])
          AND is_test = true
          AND (
            phone ~ '^[+]861(380000000|390000004)[0-9]$'
            OR id::text ~* '^00000000-0000-0000-0000-0000000000[0-9a-f]{2}$'
          )
        RETURNING id::text, phone, is_test
      `,
      [selection.selected.map((user) => user.id)],
    );

    if (deleteResult.rows.length !== selection.selected.length) {
      throw new Error('allowlist changed during cleanup; deletion was rolled back');
    }

    await client.query('COMMIT');
    return deleteResult.rows;
  } catch (error: unknown) {
    if (transactionStarted) await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const cli = parseArgs(process.argv.slice(2));
    if (cli.help) {
      console.log(HELP);
      return;
    }

    const environment = DeleteEnvironmentSchema.safeParse(process.env);
    if (!environment.success) {
      throw new Error('DATABASE_URL is required (no database connection was attempted)');
    }

    if (cli.apply) {
      console.log('APPLY mode: creating the mandatory pre-deletion backup...');
      const backup = await backupDatabase({
        databaseUrl: environment.data.DATABASE_URL,
        ...(environment.data.NODE_ENV === undefined
          ? {}
          : { environment: environment.data.NODE_ENV }),
      });
      console.log(`Backup created: ${backup.path}`);
      console.log(`Backup size: ${formatBytes(backup.sizeBytes)}`);
    } else {
      console.log('DRY RUN: no rows will be deleted. Use --apply only after reviewing this plan.');
    }

    const pool = createPool(environment.data.DATABASE_URL);
    try {
      const client = await pool.connect();
      try {
        const deleted = await inspectAndMaybeDelete(client, cli);
        if (cli.apply) {
          printAccounts('Deleted accounts', deleted);
        } else {
          console.log('DRY RUN complete: no rows were changed.');
        }
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  } catch (error: unknown) {
    console.error(
      `TEST_ACCOUNT_CLEANUP_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
