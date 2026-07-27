import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  formatSetRefFirstLine,
  parseCanonicalRpeMinorUnits,
  parseCanonicalWeightMinorUnits,
  SetRefV1Schema,
  type SetRefV1,
} from '../src/domain/set-ref';

interface GoldenFixtures {
  valid: { name: string; set_ref: unknown; first_line: string }[];
  invalid: { name: string; patch: Record<string, unknown> }[];
  exercise_name_code_point_boundaries: {
    name: string;
    unit: string;
    repeat: number;
    valid: boolean;
  }[];
}

const fixtures = JSON.parse(
  fs.readFileSync('specs/029-set-ref-chat-card/fixtures/set-ref-v1.json', 'utf8'),
) as GoldenFixtures;

describe('set_ref v1 shared golden fixtures', () => {
  it.each(fixtures.valid)('accepts and formats $name byte-for-byte', (fixture) => {
    const parsed = SetRefV1Schema.parse(fixture.set_ref);
    expect(formatSetRefFirstLine(parsed)).toBe(fixture.first_line);
  });

  it.each(fixtures.invalid)('rejects $name', (fixture) => {
    const base = fixtures.valid[1]?.set_ref;
    if (!base || typeof base !== 'object') throw new Error('missing valid golden fixture');
    expect(SetRefV1Schema.safeParse({ ...base, ...fixture.patch }).success).toBe(false);
  });

  it.each(fixtures.exercise_name_code_point_boundaries)(
    'checks $name by Unicode code points',
    (fixture) => {
      const base = fixtures.valid[1]?.set_ref;
      if (!base || typeof base !== 'object') throw new Error('missing valid golden fixture');
      const exerciseName = fixture.unit.repeat(fixture.repeat);

      expect(Array.from(exerciseName)).toHaveLength(fixture.repeat);
      expect(SetRefV1Schema.safeParse({ ...base, exercise_name: exerciseName }).success).toBe(
        fixture.valid,
      );
    },
  );

  it('uses capture groups for decimal minor units, including floating-point trap values', () => {
    expect(parseCanonicalWeightMinorUnits('0.29')).toBe(29);
    expect(parseCanonicalWeightMinorUnits('1.15')).toBe(115);
    expect(parseCanonicalWeightMinorUnits('9999.99')).toBe(999_999);
    expect(parseCanonicalWeightMinorUnits('100.10')).toBeNull();
    expect(parseCanonicalWeightMinorUnits('08')).toBeNull();

    expect(parseCanonicalRpeMinorUnits('0')).toBe(0);
    expect(parseCanonicalRpeMinorUnits('8.5')).toBe(85);
    expect(parseCanonicalRpeMinorUnits('10')).toBe(100);
    expect(parseCanonicalRpeMinorUnits('8.0')).toBeNull();
    expect(parseCanonicalRpeMinorUnits('8.3')).toBeNull();
    expect(parseCanonicalRpeMinorUnits('10.5')).toBeNull();
  });

  it('rejects control characters, JSON numbers, oversized set numbers, and extra keys', () => {
    const base = SetRefV1Schema.parse(fixtures.valid[1]?.set_ref) satisfies SetRefV1;
    for (const candidate of [
      { ...base, exercise_name: '深蹲\n伪造首行' },
      { ...base, weight_kg: 100 },
      { ...base, rpe: 8.5 },
      { ...base, set_number: 2_147_483_649 },
      { ...base, extra: 'forbidden' },
    ]) {
      expect(SetRefV1Schema.safeParse(candidate).success).toBe(false);
    }
  });
});
