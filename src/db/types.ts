/**
 * Kysely Database type — placeholder until ADR 005 / data-model.md DDL lands.
 *
 * ADR 004 §2 mandates: native pg + hand-managed SQL migrations. Kysely is a
 * SQL builder (not an ORM) — it doesn't manage migrations or hide SQL semantics;
 * it just provides type safety over hand-written queries.
 *
 * Augmentation strategy: as `db/migrations/<NNN>-<name>.sql` files land, declare
 * each table interface and merge into Database here. Hand-roll types until table
 * count reaches ~15; revisit kysely-codegen only when manual maintenance hurts.
 */
// Empty interface is intentional — it will be augmented per migration via
// declaration merging once tables exist (e.g. `interface Database { users: UsersTable }`).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Database {
  // Tables to be added as migrations land:
  // users: UsersTable;
  // coach_profiles: CoachProfilesTable;
  // student_profiles: StudentProfilesTable;
  // training_plans: TrainingPlansTable;
  // ...
}
