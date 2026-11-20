# 070 · 按已排好的课发布（后端卡 A）

2026-11-20，T2 / P1。Codex 实装到一半额度用完，Claude 明示降级接手收尾。基点 `b1bd576`（origin/staging）。

## 改动

- 迁移 0090：`plan_days.is_placeholder BOOLEAN NOT NULL DEFAULT FALSE`，纯增列，存量行全部为 false，旧语义不变，无回填。
- 发布带 `allow_empty_training_days=true` 时：只要至少一个动作、且所有动作都有组即可发布；没动作、没打卡、没完成的训练日标成占位日。不带参数的旧客户端校验不变。
- 占位日只给教练看：学员计划详情、接续、打卡/完成、日程后移、提醒、连续天数、结算、首练引导等查询全部排除占位日。
- 批量保存补课：客户端用「删同格旧日 + 新增同格」表达补课。命中占位日时改为原地更新该行（清占位标记、写动作），保留原 day id 和已挂的后移记录。这是 Codex 停下时撞到的问题（旧逻辑新建了一行，id 与后移都丢了）。
- 详情与批量回包加 `partial_plan_publication_enabled: true`，网页据此判断后端是否已上线本功能。

## 证据

- 回归测试 `fills a retained empty date after partial publication…` 改前红（id 不一致），改后绿。
- 全量 `vitest run` 2264 绿 / 6 skip；`tsc`、`eslint`、`prettier --check` 干净。
- 真 PostgreSQL 17 + Chrome 端到端（scratch 夹具，12 周只排前 2 周）：首发学员 4 节、教练 24 天；补 W3D1 后学员 5 节，W3D1 保持原 id 与原推荐日期，占位日剩 19。

## 待办

- 部署 staging 前按账本应用 0090，先后端后网页。

## 部署（2026-11-20）

David 放行。#433、plan-web #183 合并，#434 换装 web；David 在 DMS 应用 0090 并截图复查。`sha-375a3e9` 经 deploy 44727016791 上线国内 staging；线上入口 `index-Cek3YvXH.js` 哈希与构建一致，`/health` 200。台账见 `db/MIGRATIONS-APPLIED.md`。线上真实账号走查未做。
