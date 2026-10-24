import type { Cell, Outline } from './model';

const DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})$/;
const DAY =
  /^(?:(?:周|星期)[一二三四五六日天]|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|day\s*\d+|d\s*\d+|第\s*\d+\s*天)\.?$/i;

function hasContent(text: string): boolean {
  return (
    !DATE.test(text) &&
    !DAY.test(text) &&
    text !== '休息' &&
    !Number.isFinite(Number(text)) &&
    /\p{L}/u.test(text)
  );
}

function confirmedTrainingDays(cells: Cell[], content: Cell[]): number | undefined {
  const headers = cells.filter(([, , text]) => DATE.test(text) || DAY.test(text));
  const first = headers[0];
  // Only infer simple aligned day blocks. Missing/mixed headers keep the model's hint.
  if (!first || headers.length < 2) return undefined;
  const horizontal = headers.every(([row]) => row === first[0]);
  const vertical = headers.every(([, col]) => col === first[1]);
  if (!horizontal && !vertical) return undefined;
  const axis = horizontal ? 1 : 0;
  const crossAxis = horizontal ? 0 : 1;
  const boundaries = [...new Set(headers.map((cell) => cell[axis]))].sort((a, b) => a - b);
  if (boundaries.length < 2) return undefined;
  const occupied = new Set<number>();
  for (const cell of content) {
    if (cell[crossAxis] < first[crossAxis]) return undefined;
    const block = boundaries.filter((boundary) => cell[axis] >= boundary).length - 1;
    if (block < 0) return undefined;
    occupied.add(block);
  }
  return occupied.size;
}

export function filterOutlineWeeks(outline: Outline, cells: Cell[]): Outline {
  return {
    ...outline,
    weeks: outline.weeks
      .flatMap((week) => {
        const { region } = week;
        const regionCells = cells.filter(
          ([row, col]) =>
            row >= region.r1 && row <= region.r2 && col >= region.c1 && col <= region.c2,
        );
        const content = regionCells.filter(([, , text]) => hasContent(text));
        if (content.length === 0) return [];
        const confirmed = confirmedTrainingDays(regionCells, content);
        return [
          {
            ...week,
            training_days:
              confirmed !== undefined && week.training_days > confirmed
                ? confirmed
                : week.training_days,
          },
        ];
      })
      .map((week, index) => ({ ...week, index })),
  };
}
