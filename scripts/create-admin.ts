import { z } from 'zod';

import { createDb } from '../src/db/kysely';
import { createPool } from '../src/db/pool';
import {
  AdminProvisioningError,
  provisionAdmin,
  type ProvisionAdminResult,
} from '../src/services/adminProvisioning';

const AdminEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ADMIN_PHONE: z.string().regex(/^\+[1-9]\d{7,14}$/, 'ADMIN_PHONE must use E.164 format'),
  ADMIN_PASSWORD: z
    .string()
    .min(8, 'ADMIN_PASSWORD must be at least 8 characters')
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
      message: 'ADMIN_PASSWORD must be at most 72 UTF-8 bytes',
    }),
});

export { provisionAdmin };
export type { ProvisionAdminResult };

async function main(): Promise<void> {
  const parsed = AdminEnvironmentSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('ADMIN_ENV_INVALID');
    process.exitCode = 1;
    return;
  }

  const pool = createPool(parsed.data.DATABASE_URL);
  const db = createDb(pool);
  try {
    const result = await provisionAdmin(db, {
      phone: parsed.data.ADMIN_PHONE,
      password: parsed.data.ADMIN_PASSWORD,
    });
    console.log(`ADMIN_${result.action.toUpperCase()}`);
  } catch (error: unknown) {
    if (error instanceof AdminProvisioningError) {
      console.error(error.code);
    } else {
      // Operator-run script: surface the underlying failure (pg error messages
      // do not contain credentials) instead of a blind generic code.
      console.error('ADMIN_CREATE_FAILED');
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  void main();
}
