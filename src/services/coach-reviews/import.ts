import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types';
import { ListedCoachInput } from './schema';

const columns = [
  '姓名/称呼',
  '网名',
  '性别',
  '抖音号',
  '抖音主页链接',
  '省份',
  '城市',
  '所属场馆/工作室',
  '授课方式',
  '最好总成绩(kg)',
  '比赛级别',
  '装备类别',
  '资质认证',
  '执教年限',
];
/** CSV quoting, escaped quotes, BOM and embedded newlines; no spreadsheet dependency. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  const input = csv.replace(/^\uFEFF/u, '');
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell);
      cell = '';
      if (char !== ',') {
        if (char === '\r' && input[i + 1] === '\n') i++;
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
      }
    } else cell += char;
  }
  if (quoted) throw new Error('INVALID_CSV');
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
export async function importListedCoaches(db: Kysely<Database>, csv: string) {
  const [header, ...rows] = parseCsv(csv);
  if (!header || columns.slice(0, 9).some((c) => !header.map((v) => v.trim()).includes(c)))
    throw new Error('INVALID_CSV_HEADERS');
  let created = 0,
    updated = 0;
  const skips: { row: number; reason: string }[] = [];
  for (const [index, row] of rows.entries()) {
    const values = Object.fromEntries(header.map((h, i) => [h.trim(), row[i]?.trim() ?? '']));
    const get = (index: number) => values[columns[index] ?? ''] ?? '';
    if (get(0).includes('示例')) {
      skips.push({ row: index + 2, reason: 'example' });
      continue;
    }
    const parsed = ListedCoachInput.safeParse({
      name: get(0),
      nickname: get(1),
      gender: get(2),
      douyin_handle: get(3),
      douyin_url: get(4),
      province: get(5),
      city: get(6),
      gyms: get(7).split(/[;；、]/u),
      teaching_mode: get(8),
      best_total_kg: get(9) ? Number(get(9)) : null,
      competition_class: get(10) || null,
      equipment: get(11) || null,
      certifications: get(12) || null,
      coaching_years: get(13) ? Number(get(13)) : null,
    });
    if (!parsed.success) {
      skips.push({ row: index + 2, reason: 'invalid_fields' });
      continue;
    }
    const data = { ...parsed.data, status: 'published' as const, updated_at: new Date() };
    const id = randomUUID();
    const inserted = await db
      .insertInto('listed_coaches')
      .values({ ...data, id })
      .onConflict((oc) => oc.column('douyin_handle').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted?.id === id) created++;
    else {
      await db
        .updateTable('listed_coaches')
        .set(data)
        .where('douyin_handle', '=', data.douyin_handle)
        .execute();
      updated++;
    }
  }
  return { created, updated, skipped: skips.length, skips };
}
