import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildApplyCommand,
  inspectAndMaybeDelete,
  isAllowlisted,
  parseArgs,
  selectApplyCandidates,
  type UserRow,
} from '../../scripts/delete-test-accounts';

const seedCoach: UserRow = {
  id: '00000000-0000-0000-0000-000000000001',
  phone: '+8613800000001',
  is_test: true,
};

const seedStudent: UserRow = {
  id: '00000000-0000-0000-0000-000000000002',
  phone: '+8613800000002',
  is_test: true,
};

const realStudent: UserRow = {
  id: '10000000-0000-4000-8000-000000000003',
  phone: '+8613812345678',
  is_test: false,
};

const incorrectlyMarkedStudent: UserRow = {
  ...realStudent,
  is_test: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('delete-test-accounts safety logic', () => {
  it('requires is_test plus an independent phone or UUID allowlist signal', () => {
    const phoneOnly: UserRow = {
      id: '10000000-0000-4000-8000-000000000004',
      phone: '+8613800000009',
      is_test: true,
    };
    const uppercaseUuidOnly: UserRow = {
      id: '00000000-0000-0000-0000-0000000000AB',
      phone: '+8613812345678',
      is_test: true,
    };
    const phonePastSegmentEnd: UserRow = {
      ...phoneOnly,
      phone: '+8613800000010',
    };

    expect(isAllowlisted(seedCoach)).toBe(true);
    expect(isAllowlisted(seedStudent)).toBe(true);
    expect(isAllowlisted(phoneOnly)).toBe(true);
    expect(isAllowlisted(uppercaseUuidOnly)).toBe(true);
    expect(isAllowlisted(phonePastSegmentEnd)).toBe(false);
    expect(isAllowlisted(realStudent)).toBe(false);
    expect(isAllowlisted({ ...seedCoach, is_test: false })).toBe(false);
    expect(isAllowlisted(incorrectlyMarkedStudent)).toBe(false);
  });

  it('parses repeated reviewed IDs and rejects unsafe CLI shapes', () => {
    expect(
      parseArgs(['--apply', '--id', seedCoach.id, `--id=${seedStudent.id.toUpperCase()}`]),
    ).toEqual({
      apply: true,
      help: false,
      ids: [seedCoach.id, seedStudent.id],
    });

    expect(() => parseArgs(['--apply'])).toThrow('--apply requires at least one --id <uuid>');
    expect(() => parseArgs(['--id', seedCoach.id])).toThrow('--id can only be used with --apply');
    expect(() => parseArgs(['--wat'])).toThrow('Unknown argument: --wat');
  });

  it('aborts the whole apply selection when any requested ID is not allowlisted', () => {
    expect(() =>
      selectApplyCandidates(
        [seedCoach, seedStudent, incorrectlyMarkedStudent],
        [seedCoach.id, incorrectlyMarkedStudent.id],
      ),
    ).toThrow(incorrectlyMarkedStudent.id);

    expect(() =>
      selectApplyCandidates(
        [seedCoach, seedStudent],
        [seedCoach.id, '20000000-0000-4000-8000-000000000099'],
      ),
    ).toThrow('not currently allowlisted');
  });

  it('selects only supplied allowlisted IDs and leaves every other account untouched', () => {
    const selection = selectApplyCandidates(
      [seedCoach, seedStudent, incorrectlyMarkedStudent],
      [seedCoach.id],
    );

    expect(selection.selected).toEqual([seedCoach]);
    expect(selection.skippedWithoutId).toEqual([seedStudent]);
    expect(selection.skippedOutsideAllowlist).toEqual([incorrectlyMarkedStudent]);
    expect(buildApplyCommand([seedCoach, seedStudent])).toBe(
      `pnpm tsx scripts/delete-test-accounts.ts --apply --id ${seedCoach.id} --id ${seedStudent.id}`,
    );
  });

  it('warns and skips an is_test row outside the allowlist during dry-run', async () => {
    const query = vi.fn((sql: string) => {
      if (sql.includes('FROM public.users')) {
        return Promise.resolve({
          rows: [seedCoach, incorrectlyMarkedStudent],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await inspectAndMaybeDelete({ query } as unknown as PoolClient, {
      apply: false,
      help: false,
      ids: [],
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(incorrectlyMarkedStudent.id));
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM'))).toBe(false);
  });

  it('rolls back before DELETE when a supplied apply ID is not allowlisted', async () => {
    const query = vi.fn((sql: string) => {
      if (sql.includes('FROM public.users')) {
        return Promise.resolve({ rows: [seedCoach, incorrectlyMarkedStudent] });
      }
      return Promise.resolve({ rows: [] });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      inspectAndMaybeDelete({ query } as unknown as PoolClient, {
        apply: true,
        help: false,
        ids: [seedCoach.id, incorrectlyMarkedStudent.id],
      }),
    ).rejects.toThrow(incorrectlyMarkedStudent.id);

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM'))).toBe(false);
  });

  it('passes only explicitly supplied allowlisted IDs to DELETE', async () => {
    const query = vi.fn((sql: string, values?: unknown[]) => {
      if (sql.includes('DELETE FROM public.users')) {
        expect(values).toEqual([[seedCoach.id]]);
        return Promise.resolve({ rows: [seedCoach] });
      }
      if (sql.includes('FROM public.users')) {
        return Promise.resolve({
          rows: [seedCoach, seedStudent, incorrectlyMarkedStudent],
        });
      }
      if (sql.includes('FROM pg_constraint')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const deleted = await inspectAndMaybeDelete({ query } as unknown as PoolClient, {
      apply: true,
      help: false,
      ids: [seedCoach.id],
    });

    expect(deleted).toEqual([seedCoach]);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });
});
