import type { Sheet } from './model';

export function isReferenceSheet(name: string): boolean {
  return /^(?:说明|使用说明|注意事项|热身说明|营养|计算器|rpe(?:表|对照表|chart|table)?|动作库|记录页|记录表|训练记录|训练日志|instructions?|readme|calculator|exerciselibrary|traininglog)$/i.test(
    name.replace(/\s/g, ''),
  );
}

function splitName(name: string) {
  for (const [kind, pattern] of [
    ['week', /^(.*?)(?:第\s*(\d+)\s*周|week\s*(\d+))\s*$/i],
    ['day', /^(.*?)(?:第\s*(\d+)\s*天|day\s*(\d+)|\bd\s*(\d+))\s*$/i],
  ] as const) {
    const match = pattern.exec(name);
    if (!match) continue;
    const ordinal = Number(match[2] ?? match[3] ?? match[4]);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) return undefined;
    return {
      kind,
      ordinal,
      prefix: (match[1] ?? '')
        .trim()
        .replace(/[-_：:]$/, '')
        .trim()
        .toLowerCase(),
    };
  }
  return undefined;
}

// Use column definitions, never exercise names or prescriptions, as merge evidence.
// Unsupported layouts stay separate instead of guessing from names alone.
function headerStructure(sheet: Sheet): string | undefined {
  const rows = [...new Set(sheet.cells.map(([row]) => row))].sort((a, b) => a - b).slice(0, 40);
  const labels = sheet.cells.flatMap(([row, col, text]) => {
    if (!rows.includes(row)) return [];
    const label = text.toLowerCase().replace(/\s/g, '');
    const known =
      /^(?:训练动作|訓練動作|动作名称|動作名稱|动作|動作|exercise|movement|组数|組數|sets?|次数|次數|下數|reps?|重量|预期重量|預期重量|weight|load|rpe|rir|强度|強度|intensity|备注|備註|教练指示|教練指示|notes?)$/;
    return known.test(label) ? [{ row, col, label }] : [];
  });
  if (labels.length < 2) return undefined;
  // Body length can move later day headers. Compare their order and columns,
  // rather than the number of intervening exercise rows.
  const headerRows = [...new Set(labels.map((cell) => cell.row))].sort((a, b) => a - b);
  const firstCol = Math.min(...labels.map((cell) => cell.col));
  return JSON.stringify(
    labels
      .sort((a, b) => a.row - b.row || a.col - b.col)
      .map(({ row, col, label }) => [headerRows.indexOf(row), col - firstCol, label]),
  );
}

export function groupBlockSheets(sheets: Sheet[]): Sheet[][] {
  const groups: { sheets: Sheet[]; key: string | undefined; ordinals: number[] }[] = [];
  for (const sheet of sheets) {
    const name = splitName(sheet.name);
    const structure = headerStructure(sheet);
    const key = name && structure ? JSON.stringify([name.kind, name.prefix, structure]) : undefined;
    const group = key === undefined ? undefined : groups.find((group) => group.key === key);
    if (group && name) {
      group.sheets.push(sheet);
      group.ordinals.push(name.ordinal);
    } else groups.push({ sheets: [sheet], key, ordinals: name ? [name.ordinal] : [] });
  }
  return groups.flatMap((group) => {
    // Duplicate ordinals do not establish a split-sheet sequence.
    if (new Set(group.ordinals).size !== group.ordinals.length)
      return group.sheets.map((sheet) => [sheet]);
    return [
      group.sheets.sort(
        (a, b) => (splitName(a.name)?.ordinal ?? 0) - (splitName(b.name)?.ordinal ?? 0),
      ),
    ];
  });
}
