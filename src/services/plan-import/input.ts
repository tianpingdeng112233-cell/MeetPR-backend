import { z } from 'zod';
import type { Cell, Sheet } from './model';
import { groupBlockSheets, isReferenceSheet } from './block-sheets';

export const MAX_INPUT_CHARS = 400_000;
export const OUTLINE_TOKEN_BUDGET = 60_000;
const CellSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
  z
    .string()
    .min(1)
    .refine((value) => value === value.trim()),
]);
const CellsSchema = z.array(CellSchema).max(MAX_INPUT_CHARS);
export const OutlineRequestSchema = z
  .object({
    trainee_id: z.string().uuid(),
    source: z.enum(['file', 'paste']),
    sheets: z
      .array(z.object({ name: z.string().min(1).max(255), cells: CellsSchema }).strict())
      .min(1)
      .refine((sheets) => new Set(sheets.map((sheet) => sheet.name)).size === sheets.length)
      .transform((sheets) => sheets.filter((sheet) => sheet.cells.length > 0)),
  })
  .strict();
export const WeeksRequestSchema = z
  .object({
    weeks: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            sheet: z.string().min(1).max(255).optional(),
            cells: CellsSchema,
          })
          .strict(),
      )
      .min(1)
      .max(12)
      .refine((weeks) => new Set(weeks.map((week) => week.index)).size === weeks.length),
    header_cells: CellsSchema.optional(),
    header_cells_by_sheet: z.record(z.string().min(1).max(255), CellsSchema).optional(),
  })
  .strict()
  .refine((input) => input.header_cells !== undefined || input.header_cells_by_sheet !== undefined);

export function normalizeDateCells(cells: Cell[]): Cell[] {
  return cells.map(([row, col, text]) => {
    const serial = /^\d+$/.test(text) ? Number(text) : NaN;
    const normalized =
      serial >= 36526 && serial <= 73050
        ? new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10)
        : text;
    return [row, col, normalized];
  });
}

export function cellChars(cells: Cell[]): number {
  return cells.reduce((sum, cell) => sum + cell[2].length, 0);
}

function estimatedTokens(value: unknown): number {
  // Approximate mixed Chinese/ASCII budget, including coordinates/JSON syntax.
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3);
}

export function trimBlockOutlines(sheets: Sheet[]): ReturnType<typeof trimOutline> {
  const trimmed = groupBlockSheets(sheets.filter((sheet) => !isReferenceSheet(sheet.name))).map(
    trimOutline,
  );
  if (trimmed.some((block) => !block)) return undefined;
  return {
    sheets: trimmed.flatMap((block) => block?.sheets ?? []),
    truncated_rows: trimmed.reduce((total, block) => total + (block?.truncated_rows ?? 0), 0),
  };
}

export function trimOutline(
  sheets: Sheet[],
): { sheets: Sheet[]; truncated_rows: number } | undefined {
  let budget =
    OUTLINE_TOKEN_BUDGET -
    estimatedTokens({ sheets: sheets.map((sheet) => ({ name: sheet.name, cells: [] })) });
  const pages = sheets.map((sheet) => {
    const byRow = new Map<number, Cell[]>();
    for (const cell of normalizeDateCells(sheet.cells)) {
      const row = byRow.get(cell[0]) ?? [];
      row.push(cell);
      byRow.set(cell[0], row);
    }
    const rows = [...byRow.entries()].sort(([a], [b]) => a - b).map(([, cells]) => cells);
    const headers = rows.slice(0, 40);
    for (const row of headers) budget -= estimatedTokens(row);
    return { name: sheet.name, kept: headers, tail: rows.slice(40), totalRows: rows.length };
  });
  // Whole rows are indivisible. If mandatory headers alone exceed the budget,
  // ask for a smaller input instead of silently removing column definitions.
  if (budget < 0) return undefined;
  while (pages.some((page) => page.tail.length > 0)) {
    for (const page of pages) {
      const row = page.tail.pop();
      if (!row) continue;
      const cost = estimatedTokens(row);
      if (cost > budget) {
        page.tail = [];
        continue;
      }
      budget -= cost;
      page.kept.push(row);
    }
  }
  return {
    sheets: pages.map((page) => ({
      name: page.name,
      cells: page.kept.flat().sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    })),
    truncated_rows: pages.reduce((sum, page) => sum + page.totalRows - page.kept.length, 0),
  };
}
