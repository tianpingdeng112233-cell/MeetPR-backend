# 053 · 返修 R1

先读 `specs/053-exercise-adoption/SPEC.md`（§1、§2 已于 10/22 更正）与 `docs/CODEX-JOURNAL.md` 末段 053 交付记录。在本 worktree 现有未提交改动之上做。

## 返修项

1. **迁移改号 0078**：`db/migrations/0077-exercise-adoption.sql` → `0078-exercise-adoption.sql`，对应测试文件与所有引用同步改名。0077 已被远端分支 `0077-users-preferred-locale.sql` 占用。
2. **归一名口径**：`GET /admin/custom-exercises` 的分组键改为「全角字符转半角、去掉所有空白、转小写」（与网页端 `src/features/admin/adoptionCandidates.ts` 的 `normalizeAdoptionName` 同口径）。先加红测：「保加利亚分腿蹲」与「保加利亚 分腿蹲」（以及全角字母/空格的写法）落在同一组，`coach_count` / `plan_count` 合并正确。

## 约束

同原卡：不改历史数据、不加依赖、不改锁文件、不 commit / push / 开 PR。

## 交付

JOURNAL 追加「053 R1」：红 → 绿证据、typecheck / lint / 全量测试结果（沙箱内起不了 supertest 监听的话如实写明，Claude 会在沙箱外复跑）。
