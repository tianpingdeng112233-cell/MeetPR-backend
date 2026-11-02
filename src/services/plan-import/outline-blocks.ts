import { groupBlockSheets } from './block-sheets';
import {
  OutlineSchema,
  type BlocksOutline,
  type Outline,
  type OutlineBlock,
  type PlanImportModel,
  type Sheet,
  type UsageObserver,
} from './model';
import { filterOutlineWeeks } from './filter-outline';
import { runModelCall } from './retry';

export async function outlineBlocks(
  model: PlanImportModel,
  sheets: Sheet[],
  sourceSheets: Sheet[],
  onUsage: UsageObserver,
): Promise<BlocksOutline> {
  const outlines: Outline[] = [];
  let next = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(4, sheets.length) }, async () => {
      while (next < sheets.length) {
        const position = next++;
        const sheet = sheets[position];
        if (!sheet) return;
        const result = await runModelCall(async () => {
          const output = OutlineSchema.parse(await model.outline({ sheets: [sheet] }, onUsage));
          if (output.sheet !== sheet.name) throw new Error('MODEL_UNKNOWN_SHEET');
          return output;
        });
        outlines[position] = filterOutlineWeeks(
          result,
          sourceSheets.find((source) => source.name === sheet.name)?.cells ?? [],
        );
      }
    }),
  );
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;

  const blocks: OutlineBlock[] = groupBlockSheets(sourceSheets)
    .flatMap((group) => {
      const plans = group.flatMap((sheet) => {
        const outline = outlines.find((outline) => outline.sheet === sheet.name);
        return outline?.weeks.length ? [outline] : [];
      });
      const first = plans[0];
      const last = plans.at(-1);
      if (!first || !last) return [];
      return [
        {
          id: '',
          label: plans.length === 1 ? first.sheet : `${first.sheet}–${last.sheet}`,
          sheets: plans.map((outline) => outline.sheet),
          weeks: plans
            .flatMap((outline) =>
              outline.weeks.map((week) => ({
                ...week,
                region: { ...week.region, sheet: outline.sheet },
              })),
            )
            .map((week, index) => ({ ...week, index })),
          header_region_by_sheet: Object.fromEntries(
            plans.map((outline) => [outline.sheet, outline.header_region]),
          ),
        },
      ];
    })
    .map((block, index) => ({ ...block, id: `block-${String(index + 1)}` }));
  // A later block wins ties, including the all-undated case.
  const latest = (block: OutlineBlock) =>
    block.weeks.reduce(
      (date, week) => (week.start_date && week.start_date > date ? week.start_date : date),
      '',
    );
  const selected = blocks.reduce<OutlineBlock | undefined>(
    (chosen, block) => (!chosen || latest(block) >= latest(chosen) ? block : chosen),
    undefined,
  );
  const sheet = selected?.sheets[0] ?? sheets[0]?.name ?? '';
  return {
    sheet,
    weeks: selected?.weeks ?? [],
    header_region: selected?.header_region_by_sheet[sheet] ?? null,
    blocks,
    skipped_sheets: sourceSheets
      .filter((source) => !blocks.some((block) => block.sheets.includes(source.name)))
      .map((source) => source.name),
  };
}
