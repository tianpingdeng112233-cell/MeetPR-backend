/**
 * Local only; never run in CI or check real workbooks into this public repository.
 * XLSX prerequisite: python3 -m pip install openpyxl
 * Supply DEEPSEEK_API_KEY through your approved environment/secret channel.
 * Run: pnpm exec tsx scripts/plan-import-eval.ts /absolute/local/sample.xlsx sample.csv
 * Reader-only smoke check (no key/network): add --dry-run before the paths.
 * stdout contains aggregate JSON summaries only, never filenames/names/cell text.
 */
import { spawnSync } from 'node:child_process';

import { createDeepSeekPlanImportModel } from '../src/services/plan-import/deepseek';
import {
  cellChars,
  MAX_INPUT_CHARS,
  OutlineRequestSchema,
  trimOutline,
} from '../src/services/plan-import/input';
import type { Cell, Sheet } from '../src/services/plan-import/model';
import { parseWeeks } from '../src/services/plan-import/parse-weeks';

// openpyxl handles Excel's 1900/1904 epochs and date styles. data_only reads cached
// formula values; this tool never executes spreadsheet formulas or macros.
const READER = String.raw`
import csv, datetime, json, pathlib, sys
try:
    path = pathlib.Path(sys.argv[1])
    sheets = []
    def text(value):
        if value is None: return ''
        if isinstance(value, datetime.datetime): return value.date().isoformat()
        if isinstance(value, datetime.date): return value.isoformat()
        if isinstance(value, float) and value.is_integer(): return str(int(value))
        return str(value).strip()
    def cells(rows):
        return [[r, c, t] for r, row in enumerate(rows, 1)
                for c, value in enumerate(row, 1) if (t := text(value))]
    if path.suffix.lower() == '.csv':
        with path.open(encoding='utf-8-sig', newline='') as f:
            sheets = [{'name': 'Sheet1', 'cells': cells(csv.reader(f))}]
    elif path.suffix.lower() == '.xlsx':
        import openpyxl
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            sheets = [{'name': page.title, 'cells': cells(page.values)} for page in workbook.worksheets]
        finally:
            workbook.close()
    else:
        raise ValueError('unsupported input')
    print(json.dumps([s for s in sheets if s['cells']], ensure_ascii=False))
except Exception:
    # Never print exception messages: they may contain a private path/cell.
    sys.exit(1)
`;

function readSheets(path: string): Sheet[] {
  const result = spawnSync('python3', ['-c', READER, path], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error('LOCAL_READ_FAILED');
  const sheets: unknown = JSON.parse(result.stdout);
  return OutlineRequestSchema.parse({
    trainee_id: '00000000-0000-4000-8000-000000000000',
    source: 'file',
    sheets,
  }).sheets;
}

function inRegion(
  cells: Cell[],
  region: { r1: number; c1: number; r2: number; c2: number } | null,
): Cell[] {
  if (!region) return [];
  return cells.filter(
    ([r, c]) => r >= region.r1 && r <= region.r2 && c >= region.c1 && c <= region.c2,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args[0] === '--dry-run';
  const paths = dryRun ? args.slice(1) : args;
  if (paths.length === 0) {
    process.stderr.write(
      'Usage: pnpm exec tsx scripts/plan-import-eval.ts [--dry-run] <local.xlsx|local.csv>...\n',
    );
    process.exitCode = 1;
    return;
  }
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!dryRun && !apiKey) {
    process.stderr.write(
      'DEEPSEEK_API_KEY is required via the environment. No key was read from a file.\n',
    );
    process.exitCode = 1;
    return;
  }
  const model =
    apiKey && !dryRun
      ? createDeepSeekPlanImportModel({
          apiKey,
          baseUrl: process.env.DEEPSEEK_BASE_URL,
          model: process.env.DEEPSEEK_MODEL,
        })
      : undefined;
  for (const [fileIndex, path] of paths.entries()) {
    try {
      const sheets = readSheets(path);
      const inputChars = sheets.reduce((sum, sheet) => sum + cellChars(sheet.cells), 0);
      if (inputChars > MAX_INPUT_CHARS) throw new Error('PAYLOAD_TOO_LARGE');
      const trimmed = trimOutline(sheets);
      if (!trimmed) throw new Error('IMPORT_HEADERS_TOO_LARGE');
      if (!model) {
        process.stdout.write(
          `${JSON.stringify({ file_index: fileIndex, sheets: sheets.length, input_chars: inputChars, truncated_rows: trimmed.truncated_rows, dry_run: true })}\n`,
        );
        continue;
      }
      const usage = { prompt_tokens: 0, completion_tokens: 0 };
      const onUsage = (tokens: typeof usage) => {
        usage.prompt_tokens += tokens.prompt_tokens;
        usage.completion_tokens += tokens.completion_tokens;
      };
      const outline = await model.outline({ sheets: trimmed.sheets }, onUsage);
      const sheet = sheets.find((item) => item.name === outline.sheet);
      if (!sheet) throw new Error('MODEL_UNKNOWN_SHEET');
      if (outline.weeks.length === 0) throw new Error('NO_TRAINING_WEEKS');
      const header_cells = inRegion(sheet.cells, outline.header_region);
      process.stdout.write(
        `${JSON.stringify({ file_index: fileIndex, weeks: outline.weeks.length, truncated_rows: trimmed.truncated_rows })}\n`,
      );
      for (let offset = 0; offset < outline.weeks.length; offset += 12) {
        const batch = outline.weeks.slice(offset, offset + 12);
        const results = await parseWeeks(
          model,
          batch.map((week) => ({
            index: week.index,
            cells: inRegion(sheet.cells, week.region),
            header_cells,
          })),
          onUsage,
        );
        for (const week of results) {
          if ('error' in week) {
            process.stdout.write(`${JSON.stringify({ file_index: fileIndex, ...week })}\n`);
            process.exitCode = 1;
            continue;
          }
          const exercises = week.days.flatMap((day) => day.exercises);
          process.stdout.write(
            `${JSON.stringify({
              file_index: fileIndex,
              index: week.index,
              training_days: week.days.filter((day) => !day.rest).length,
              exercises: exercises.length,
              sets: exercises.reduce((sum, exercise) => sum + exercise.sets, 0),
              flags: {
                inferred: exercises.filter((exercise) => exercise.flags.includes('inferred'))
                  .length,
                note_fallback: exercises.filter((exercise) =>
                  exercise.flags.includes('note_fallback'),
                ).length,
              },
            })}\n`,
          );
        }
      }
      process.stdout.write(`${JSON.stringify({ file_index: fileIndex, ...usage })}\n`);
    } catch {
      process.stderr.write(
        `${JSON.stringify({ file_index: fileIndex, error: 'EVAL_FAILED', hint: 'Check local reader dependencies, input size and provider configuration.' })}\n`,
      );
      process.exitCode = 1;
    }
  }
}

void main();
