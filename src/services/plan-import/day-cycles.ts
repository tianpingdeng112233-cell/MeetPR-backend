import { normalizeDateCells } from './input';
import { OutlineSchema, RegionSchema, type Cell, type Outline, type Sheet } from './model';

const ORDINAL = /^(?:day\s*|d\s*|第\s*)(\d+)\s*(?:天)?$/i;
const CALENDAR =
  /^(?:\d{4}-\d{2}-\d{2}|(?:周|星期)[一二三四五六日天]|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?$/i;

function ordinalHeaders(cells: Cell[]) {
  const headers = cells.flatMap(([row, col, text]) => {
    const match = ORDINAL.exec(text);
    const day = Number(match?.[1]);
    return match && Number.isSafeInteger(day) && day > 0 ? [{ row, col, day }] : [];
  });
  const first = headers[0];
  if (!first) return undefined;
  if (
    normalizeDateCells(cells).some(([row, , text]) => {
      if (CALENDAR.test(text)) return true;
      // A slash in the body may denote weights. Partial dates count only
      // alongside day headers and only when they name a calendar day.
      const date = /^(\d{1,2})[/月](\d{1,2})日?$/.exec(text);
      if (!date || !headers.some((header) => header.row === row)) return false;
      const month = Number(date[1]);
      const day = Number(date[2]);
      const parsed = new Date(Date.UTC(2000, month - 1, day));
      return parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
    })
  )
    return undefined;
  const horizontal = headers.length > 1 && headers.every((header) => header.row === first.row);
  if (!horizontal && !headers.every((header) => header.col === first.col)) return undefined;
  headers.sort((a, b) => (horizontal ? a.col - b.col : a.row - b.row));
  if (!headers.every((header, i) => header.day > (headers[i - 1]?.day ?? 0))) return undefined;
  return { headers, horizontal };
}

export function splitDayCycles(outline: Outline, cells: Cell[]): Outline {
  return {
    ...outline,
    weeks: outline.weeks
      .flatMap((week) => {
        const r = week.region;
        const source = cells.filter(
          ([row, col]) => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2,
        );
        const layout = ordinalHeaders(source);
        if (!layout?.headers.some((h) => h.day > 7)) return [week];
        const groups = layout.headers.filter(
          (h, i) =>
            Math.floor((h.day - 1) / 7) !== Math.floor(((layout.headers[i - 1]?.day ?? 0) - 1) / 7),
        );
        return groups.map((header, i) => {
          const next = groups[i + 1];
          const region = { ...r };
          if (layout.horizontal) {
            region.c1 = i === 0 ? r.c1 : header.col;
            region.c2 = next ? next.col - 1 : r.c2;
          } else {
            region.r1 = i === 0 ? r.r1 : header.row;
            region.r2 = next ? next.row - 1 : r.r2;
          }
          const trainingDays = layout.headers.filter((day, position) => {
            if (Math.floor((day.day - 1) / 7) !== Math.floor((header.day - 1) / 7)) return false;
            const nextDay = layout.headers[position + 1];
            return source.some(
              ([row, col, text]) =>
                row >= day.row &&
                col >= day.col &&
                (!nextDay || (layout.horizontal ? col < nextDay.col : row < nextDay.row)) &&
                !ORDINAL.test(text) &&
                !CALENDAR.test(text) &&
                text !== '休息' &&
                !Number.isFinite(Number(text)) &&
                /\p{L}/u.test(text),
            );
          }).length;
          return {
            ...week,
            region,
            start_date: null,
            label: `Day${String(Math.floor((header.day - 1) / 7) * 7 + 1)}–Day${String(Math.floor((header.day - 1) / 7) * 7 + 7)}`,
            training_days: trainingDays,
          };
        });
      })
      .map((week, index) => ({ ...week, index })),
  };
}

// An ordinal cycle can contain more than seven training days before splitting.
// Relax only that hint when source headers prove a multi-week cycle; keep all
// other outline validation (including unique indices and valid regions) intact.
export function prepareCycleOutline(value: unknown, sheets: Sheet[]): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const raw = value as Record<string, unknown>;
  const sheet = sheets.find((item) => item.name === raw.sheet);
  if (!sheet || !Array.isArray(raw.weeks)) return value;
  const weeks = raw.weeks.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return item;
    const week = item as Record<string, unknown>;
    const region = RegionSchema.safeParse(week.region);
    if (
      !region.success ||
      typeof week.training_days !== 'number' ||
      !Number.isInteger(week.training_days) ||
      week.training_days <= 7
    )
      return item;
    const r = region.data;
    const layout = ordinalHeaders(
      sheet.cells.filter(([row, col]) => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2),
    );
    return layout?.headers.some((h) => h.day > 7) ? { ...week, training_days: 7 } : item;
  });
  const parsed = OutlineSchema.safeParse({ ...raw, weeks });
  return parsed.success ? splitDayCycles(parsed.data, sheet.cells) : value;
}

export function normalizeOrdinalWeek(value: unknown, cells: Cell[]): unknown {
  if (!ordinalHeaders(cells) || typeof value !== 'object' || value === null) return value;
  const week = value as Record<string, unknown>;
  if (!Array.isArray(week.days)) return value;
  return {
    ...week,
    start_date: null,
    days: week.days.map((day: unknown, index) =>
      typeof day === 'object' && day !== null
        ? { ...day, weekday: null, day_index: index + 1 }
        : day,
    ),
  };
}
