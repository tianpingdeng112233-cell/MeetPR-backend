import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types';
export const publicReviewColumns = [
  'coach_reviews.id',
  'coach_reviews.listed_coach_id',
  'coach_reviews.overall',
  'coach_reviews.professionalism',
  'coach_reviews.communication',
  'coach_reviews.results',
  'coach_reviews.value',
  'coach_reviews.body',
  'coach_reviews.edited',
  'coach_reviews.created_at',
  'coach_reviews.updated_at',
  'coach_review_accounts.nickname',
] as const;
export function publicReviews(db: Kysely<Database>) {
  return db
    .selectFrom('coach_reviews')
    .innerJoin('coach_review_accounts', 'coach_review_accounts.id', 'coach_reviews.account_id')
    .innerJoin('listed_coaches', 'listed_coaches.id', 'coach_reviews.listed_coach_id')
    .where('listed_coaches.status', '=', 'published')
    .where('coach_reviews.deleted_at', 'is', null)
    .select(publicReviewColumns)
    .orderBy('coach_reviews.updated_at', 'desc')
    .orderBy('coach_reviews.id');
}
export function listedCoachQuery(db: Kysely<Database>) {
  const aggregates = db
    .selectFrom('coach_reviews')
    .where('deleted_at', 'is', null)
    .select('listed_coach_id')
    .select((eb) => [
      eb.fn.countAll<number>().as('review_count'),
      eb.fn.max('created_at').as('latest_review_at'),
      ...(['overall', 'professionalism', 'communication', 'results', 'value'] as const).map((key) =>
        eb.fn.avg<number>(key).as(key),
      ),
    ])
    .groupBy('listed_coach_id')
    .as('stats');
  return db
    .selectFrom('listed_coaches')
    .leftJoin(aggregates, 'stats.listed_coach_id', 'listed_coaches.id')
    .selectAll('listed_coaches')
    .select([
      'stats.overall',
      'stats.professionalism',
      'stats.communication',
      'stats.results',
      'stats.value',
      'stats.latest_review_at',
    ])
    .select(sql<number | string>`coalesce(stats.review_count, 0)`.as('review_count'))
    .where('listed_coaches.status', '=', 'published');
}
type CoachRow = Awaited<ReturnType<ReturnType<typeof listedCoachQuery>['execute']>>[number];
export function publicCoach(row: CoachRow) {
  const {
    overall,
    professionalism,
    communication,
    results,
    value,
    review_count,
    latest_review_at: _latest,
    rejection_reason: _rejection,
    submitted_by: _submitted,
    reviewed_by: _reviewer,
    reviewed_at: _reviewedAt,
    douyin_handle: _handle,
    ...coach
  } = row;
  const count = Number(review_count);
  return {
    ...coach,
    best_total_kg: coach.best_total_kg === null ? null : Number(coach.best_total_kg),
    coaching_years: coach.coaching_years === null ? null : Number(coach.coaching_years),
    review_count: count,
    averages:
      count < 3
        ? null
        : {
            overall: round(overall),
            professionalism: round(professionalism),
            communication: round(communication),
            results: round(results),
            value: round(value),
          },
  };
}
function round(value: unknown) {
  return Math.round(Number(value) * 10) / 10;
}

export async function publicCoachStats(db: Kysely<Database>) {
  // Aggregate before joining so coaches with multiple reviews count once.
  const cities = await listedCoachQuery(db)
    .clearSelect()
    .select(['province', 'city'])
    .select((eb) => eb.fn.countAll<number | string>().as('coach_count'))
    .select(sql<number | string>`coalesce(sum(stats.review_count), 0)`.as('review_count'))
    .groupBy(['province', 'city'])
    .orderBy('province')
    .orderBy('city')
    .execute();
  const provinces = new Map<
    string,
    { province: string; coach_count: number; cities: { city: string; coach_count: number }[] }
  >();
  let coachCount = 0,
    reviewCount = 0;
  for (const row of cities) {
    const count = Number(row.coach_count);
    const province = provinces.get(row.province) ?? {
      province: row.province,
      coach_count: 0,
      cities: [],
    };
    province.coach_count += count;
    province.cities.push({ city: row.city, coach_count: count });
    provinces.set(row.province, province);
    coachCount += count;
    reviewCount += Number(row.review_count);
  }
  return {
    coach_count: coachCount,
    province_count: provinces.size,
    review_count: reviewCount,
    provinces: [...provinces.values()],
  };
}
