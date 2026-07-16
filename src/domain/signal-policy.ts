export const SIGNAL_POLICY = {
  missedDaysThreshold: 3, // 连续缺练 N（CEO plan 默认 3，可调）
  signalExpiryDays: 7, // open 信号过期
  sessionTimeoutHours: 4, // 会话超时归档
  dailySettlementCron: '5 4 * * *', // Asia/Shanghai
} as const;
