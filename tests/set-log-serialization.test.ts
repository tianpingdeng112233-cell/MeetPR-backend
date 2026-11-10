import { describe, expect, it } from 'vitest';
import { serializeSetLogWeight } from '../src/handlers/set-log-serialization';

describe('set-log weight capability serialization', () => {
  const examples = [
    { surface: 'student and coach set history', id: 'set-log', weight_kg: null },
    { surface: 'exercise recent and filtered sessions', set_index: 0, weight_kg: null },
    { surface: 'student video wall', set_log_id: 'set-log', weight_kg: null },
    { surface: 'student and coach feedback video', id: 'video', set_index: 0, weight_kg: null },
  ];
  it.each(examples)('preserves $surface and negotiates only an exact capability token', (row) => {
    expect(serializeSetLogWeight(row)).toEqual({ ...row, weight_kg: '0' });
    expect(serializeSetLogWeight(row, 'set-weight-nullable-v2')).toEqual({
      ...row,
      weight_kg: '0',
    });
    expect(serializeSetLogWeight(row, ['other', 'set-weight-nullable'])).toEqual(row);
    expect(row.weight_kg).toBeNull();
    expect(serializeSetLogWeight({ ...row, weight_kg: '102.5' })).toEqual({
      ...row,
      weight_kg: '102.50',
    });
    expect(serializeSetLogWeight({ ...row, weight_kg: '0' }, 'set-weight-nullable').weight_kg).toBe(
      '0.00',
    );
  });
});
