export const PUSH_POLICY = {
  dailyDigestCron: '0 8 * * *',
  consumerCron: '* * * * *',
  consumerBatchSize: 50,
  maxAttempts: 5,
  // Bounded APNs request timeout: the consumer sends inside a row transaction,
  // so an unbounded hang would pin the row lock and a DB connection forever.
  apnsRequestTimeoutMs: 10_000,
} as const;
