import { normalizeDateCells } from './input';
import type { Cell, Exercise, WeekResult } from './model';
import { PlanImportModelError } from './retry';

const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY =
  /^(?:(?:周|星期)[一二三四五六日天]|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?$/i;
const PARTIAL_DATE = /^(\d{1,2})(?:\/|月)(\d{1,2})日?$/;

function isoDate(text: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text
    ? date
    : undefined;
}

function monday(date: Date): string {
  return new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function dayHeader(text: string, anchor?: string) {
  const date = isoDate(text);
  if (date) return { weekday: (date.getUTCDay() + 6) % 7, monday: monday(date) };
  if (WEEKDAY.test(text)) {
    const chinese = '一二三四五六日'.indexOf(
      text
        .replace(/\.$/, '')
        .replace(/^(周|星期)/, '')
        .replace('天', '日'),
    );
    return {
      weekday: chinese >= 0 ? chinese : DAY_NAMES.indexOf(text.slice(0, 3).toLowerCase()),
      monday: null,
    };
  }
  const partial = PARTIAL_DATE.exec(text);
  if (partial) {
    const monthDay = `${String(Number(partial[1])).padStart(2, '0')}-${String(Number(partial[2])).padStart(2, '0')}`;
    if (!isoDate(`2000-${monthDay}`)) return undefined;
    // A yearless header is only grounded against an explicit date in the same source week.
    if (anchor) {
      const year = Number(anchor.slice(0, 4));
      for (const candidateYear of [year - 1, year, year + 1]) {
        const candidate = isoDate(`${String(candidateYear)}-${monthDay}`);
        if (candidate && monday(candidate) === anchor)
          return { weekday: (candidate.getUTCDay() + 6) % 7, monday: anchor };
      }
    }
    return { weekday: null, monday: null };
  }
  return undefined;
}

function suspect(): never {
  throw new PlanImportModelError('REGION_SUSPECT');
}

function dayBlocks(cells: Cell[]) {
  const normalized = normalizeDateCells(cells);
  const anchors = new Set(
    normalized.flatMap(([, , text]) => {
      const date = isoDate(text);
      return date ? [monday(date)] : [];
    }),
  );
  if (anchors.size > 1) return suspect();
  const headers = normalized.flatMap(([row, col, text]) => {
    const header = dayHeader(text, [...anchors][0]);
    return header ? [{ row, col, ...header }] : [];
  });
  headers.sort((a, b) => a.row - b.row || a.col - b.col);
  const first = headers[0];
  if (!first) return undefined;
  const horizontal = headers.length > 1 && headers.every((header) => header.row === first.row);
  const vertical = headers.every((header) => header.col === first.col);
  if (!horizontal && !vertical) return suspect();
  const sorted = headers.sort((a, b) => (horizontal ? a.col - b.col : a.row - b.row));
  return {
    headers: sorted,
    locate: ([row, col]: [number, number]) => {
      if (row < first.row || col < first.col) return -1;
      return sorted.findIndex((header, index) => {
        const next = sorted[index + 1];
        return horizontal
          ? col >= header.col && (!next || col < next.col)
          : row >= header.row && (!next || row < next.row);
      });
    },
  };
}

const PRESCRIPTION = /(\d+(?:\.\d+)?)\s*(?:[*x×]\s*(\d+)|组(?:\s*[*x×]\s*(\d+))?)/gi;
const WEIGHT_LIST =
  /^\d+(?:\.\d+)?(?:\s*[*x×]\s*\d+)?(?:\s*\/\s*\d+(?:\.\d+)?(?:\s*[*x×]\s*\d+)?)+$/i;

function prescriptions(text: string) {
  return [...text.matchAll(PRESCRIPTION)].map((match) => ({
    sets: Number(match[1]),
    reps: match[2] ?? match[3],
    explicitSets: match[0].includes('组'),
  }));
}

function sourcePrescriptions(text: string, exercise: Exercise) {
  const weights = new Set(exercise.weight_values.map(Number));
  // Slash-separated load/count lists are weights when each load is present in the output.
  // This avoids treating a slash-separated pair of genuine set prescriptions as weights.
  if (
    WEIGHT_LIST.test(text) &&
    text.split('/').every((part) => weights.has(Number(part.split(/[*x×]/i)[0])))
  )
    return [];
  if (/^(?:rpe|rir|强度|百分比)/i.test(text)) return [];
  return prescriptions(text).filter(({ sets, reps, explicitSets }) => {
    if (!Number.isInteger(sets)) return false;
    if (explicitSets) return true;
    if (sets === exercise.sets && (reps === undefined || reps === exercise.reps)) return true;
    const occurrences = exercise.weight_values.filter((value) => Number(value) === sets).length;
    // A standalone load*count must agree with the actual per-set weight repetitions.
    return occurrences === 0 || Number(reps) !== occurrences;
  });
}

function groundExercises(
  week: WeekResult,
  cells: Cell[],
  blocks: ReturnType<typeof dayBlocks>,
): WeekResult {
  // The leftmost candidate is selected within each day block, not across the whole row.
  const names = new Map<string, Cell>();
  for (const cell of normalizeDateCells(cells)) {
    const [row, col, text] = cell;
    const block = blocks?.locate([row, col]) ?? 0;
    if (
      block < 0 ||
      dayHeader(text) ||
      text === '休息' ||
      !/\p{L}/u.test(text) ||
      /^(?:[\d\s.+*/×x%<>=≤≥@-]+|\d+\s*组.*|(?:rpe|rir)(?:\b|(?=[\d@<>=≤≥])).*)$/i.test(text)
    )
      continue;
    const key = `${String(block)}:${String(row)}`;
    const previous = names.get(key);
    if (!previous || col < previous[1]) names.set(key, cell);
  }
  const unreadable = [...week.unreadable];
  const days = week.days.map((day) => ({
    ...day,
    exercises: day.exercises.filter((exercise) => {
      const refs = new Set(
        exercise.source_cells.map(([row, col]) => `${String(row)}:${String(col)}`),
      );
      const coveredNames = [...names.values()].filter(([row, col]) =>
        refs.has(`${String(row)}:${String(col)}`),
      );
      const nameRow =
        coveredNames.find(([, , name]) => name === exercise.name)?.[0] ??
        Math.min(...exercise.source_cells.map(([row]) => row));
      const written = cells
        .filter(([row, col]) => refs.has(`${String(row)}:${String(col)}`))
        .flatMap(([, , text]) => sourcePrescriptions(text, exercise));
      const structured = written.findIndex(
        ({ sets, reps }) =>
          sets === exercise.sets && (reps === undefined || reps === exercise.reps),
      );
      const noted = prescriptions(exercise.note);
      const unstructuredSets =
        written.length > 1 &&
        written.reduce((sum, token) => sum + token.sets, 0) > exercise.sets &&
        written.some(
          (token, index) =>
            index !== structured &&
            noted.some((note) => note.sets === token.sets && note.reps === token.reps),
        );
      if (
        unstructuredSets ||
        (new Set(exercise.source_cells.map(([row]) => row)).size > 1 &&
          coveredNames.some(([row, , name]) => row !== nameRow && name !== exercise.name))
      ) {
        unreadable.push({
          day_index: day.day_index,
          weekday: day.weekday,
          source_cells: exercise.source_cells,
          reason: 'OTHER',
          detail: null,
        });
        return false;
      }
      return true;
    }),
  }));
  return { ...week, days, unreadable };
}

export function groundWeek(week: WeekResult, cells: Cell[]): WeekResult {
  const blocks = dayBlocks(cells);
  week = groundExercises(week, cells, blocks);
  // Empty model slots have no source evidence; the importer fills absent weekdays as rest.
  const diagnosedDays = new Set(week.unreadable.map((item) => item.day_index));
  week = {
    ...week,
    days: week.days.filter((day) => day.exercises.length > 0 || diagnosedDays.has(day.day_index)),
  };
  if (!blocks) return week;
  const mondays = new Set(
    blocks.headers.flatMap((header) => (header.monday ? [header.monday] : [])),
  );
  if (mondays.size > 1) return suspect();
  const unreadable = week.unreadable.map((item) => ({ ...item }));
  const dayIndices = week.days.map((day) => {
    const locations = [
      ...day.exercises,
      ...unreadable.filter((item) => item.day_index === day.day_index),
    ];
    return new Set(locations.flatMap((item) => item.source_cells.map(blocks.locate)));
  });
  const regroup = dayIndices.some((indices) => indices.size > 1);
  if (regroup) {
    const groups = new Map<number, WeekResult['days'][number]>();
    const locate = (source: [number, number][]) => {
      const indices = new Set(source.map(blocks.locate));
      const index = [...indices][0];
      if (indices.size !== 1 || index === undefined || index < 0) return suspect();
      const header = blocks.headers[index];
      if (header?.weekday == null) return suspect();
      let group = groups.get(index);
      if (!group) {
        group = { day_index: index + 1, weekday: header.weekday, rest: false, exercises: [] };
        groups.set(index, group);
      }
      return group;
    };
    for (const day of week.days) {
      for (const exercise of day.exercises) locate(exercise.source_cells).exercises.push(exercise);
    }
    for (const item of unreadable) {
      const group = locate(item.source_cells);
      item.day_index = group.day_index;
      item.weekday = group.weekday;
    }
    const days = [...groups.entries()].sort(([a], [b]) => a - b).map(([, day]) => day);
    if (new Set(days.map((day) => day.weekday)).size !== days.length) return suspect();
    const indices = new Map(days.map((day, index) => [day.day_index, index + 1]));
    for (const item of unreadable) item.day_index = indices.get(item.day_index) ?? item.day_index;
    return {
      ...week,
      start_date: [...mondays][0] ?? week.start_date,
      days: days.map((day, index) => ({ ...day, day_index: index + 1 })),
      unreadable,
    };
  }
  const days = week.days.map((day, index) => {
    const indices = dayIndices[index] ?? new Set<number>();
    if (indices.has(-1)) return suspect();
    const block = blocks.headers[[...indices][0] ?? -1];
    const weekday = block?.weekday ?? day.weekday;
    for (const item of unreadable) if (item.day_index === day.day_index) item.weekday = weekday;
    return { ...day, weekday };
  });
  if (
    !(
      days.every((day) => day.weekday === null) ||
      (days.every((day) => day.weekday !== null) &&
        new Set(days.map((day) => day.weekday)).size === days.length)
    )
  )
    return suspect();
  return { ...week, start_date: [...mondays][0] ?? week.start_date, days, unreadable };
}
