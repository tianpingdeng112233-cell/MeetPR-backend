import { z } from 'zod';

import { isIsoCalendarDate, isoCalendarDateSchemaMessage, utcDateOnly } from '../utils/date';

export const ServiceUntilSchema = z
  .string()
  .refine(isIsoCalendarDate, isoCalendarDateSchemaMessage())
  .refine((value) => {
    const limit = new Date();
    const month = limit.getUTCMonth();
    limit.setUTCFullYear(limit.getUTCFullYear() + 5);
    // Clamp leap day to the last day of February in a non-leap target year.
    if (limit.getUTCMonth() !== month) limit.setUTCDate(0);
    return value <= utcDateOnly(limit);
  }, 'service_until must be no later than today + 5 years')
  .nullable();
