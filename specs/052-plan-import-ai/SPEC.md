# 052 — 教练表格 AI 识别（网页「从表格导入」的后端）

- **状态**: Ready（2026-10-22 /grill「确认」，逐题记录 `~/Projects/scratch/sheet-import-grill-20261022.md`）
- **产品正典**: `meetpr-plan-web` 仓 `specs/015-sheet-import-any-template/SPEC.md`。本 spec 只定后端：接 DeepSeek、两个识别接口、每日次数、能力开关。
- **级别 / 节奏**: T2（新外部依赖 + 新表迁移）/ P1。分支 `feat/052-plan-import-ai` → `staging`。PR 等 David「放行」。
- **为什么**: 现在的网页导入（plan-web spec 002）是写死的解析器，只认一位教练（Monster 宇）的版式。教练的表五花八门（日历式、流水式、合并格、一格写全「4组×8 @112.5」），换成大模型理解表格结构，后面的绑定动作 / 编辑器流程不变。

## 1. 能力开关与配置

- 新增可选 env：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）、`DEEPSEEK_MODEL`（默认 `deepseek-chat`）。
- **开关 = 是否配了 `DEEPSEEK_API_KEY`**。国内 staging / 生产配；海外不配（David 拍板 Q11：海外暂不开放导入）。没配时所有接口回 `enabled:false` 或 404，不报错、不影响启动。
- key 由 David 存 Bitwarden 并写进服务器 env；**永不进仓、日志、测试夹具**。

## 2. 接口（教练身份；`trainee_id` 必须是该教练名下学员，否则 404，沿用现有归属校验）

### 2.1 `GET /coach/plan-imports/status?trainee_id=`

`{ enabled: boolean, daily_limit: 3, remaining_today: number }`

### 2.2 `POST /coach/plan-imports` — 第一步：认结构

请求：

```jsonc
{
  "trainee_id": "uuid",
  "source": "file" | "paste",
  "sheets": [ { "name": "2026", "cells": [[row, col, "text"], ...] } ]   // 1-based；只含非空格；文本已 trim；日期格由前端转成 ISO「2026-01-05」
}
```

- **不收文件名**（文件名常是学员姓名，Q6）。
- 允许 cells 为空的 sheet，裁剪及调用模型前丢弃；全部 sheet 为空则回 422 `{ error: 'NO_TRAINING_WEEKS' }`，不调用模型、不扣次数。
- 体积上限：全部 cells 文本合计 ≤ 400k 字符，超出 413。
- 发给模型前按预算裁剪：每页保留表头（前 40 个非空行）+ 尾部最新的行，直到合计约 60k token；裁掉的行数回给前端提示。
- 模型任务：选出训练计划所在的页，列出其中**每一周**及其单元格范围。
  响应：

```jsonc
{
  "import_id": "uuid",
  "sheet": "2026",
  "truncated_rows": 0,
  "header_region": { "r1":1, "c1":1, "r2":2, "c2":36 } | null,  // 解释列含义的表头（如「组数 次数 重量」），第二步每周都带上
  "weeks": [
    { "index": 0, "label": "W1" | "第1周" | "1/5–1/11",
      "start_date": "2026-01-05" | null,          // 这周周一；表里没日期 → null
      "training_days": 4,
      "region": { "r1": 3, "c1": 1, "r2": 10, "c2": 36 } }
  ]
}
```

- 识别不出任何周 → 422 `{ error: 'NO_TRAINING_WEEKS' }`（不扣次数）。
- 模型识别失败 → 502 `{ error: 'PARSE_FAILED', reason }`（不扣次数）；`reason` 沿用 §2.3 的 `MODEL_BUSY` / `OUTPUT_TOO_LONG` / `BAD_OUTPUT`，此步不会出现 `REGION_SUSPECT`。
- **扣次数在这一步**：成功返回才记一次（Q9：单个学员每天 3 次；「天」按 Asia/Shanghai 自然日；按 教练×学员 计）。用完 → 429 `{ error: 'IMPORT_DAILY_LIMIT', remaining_today: 0 }`。

### 2.3 `POST /coach/plan-imports/:import_id/weeks` — 第二步：逐周识别内容

请求：`{ "weeks": [ { "index": 0, "cells": [[r,c,"text"], ...] } ], "header_cells": [[r,c,"text"], ...] }`（前端从原表按 region 截出；≤ 12 周，Q4）

- `import_id` 必须属于当前教练、当天创建；每个 import 最多调 **8** 次本接口（失败周重试 + 教练改格后重新识别都算），超出 409。**不另扣次数**。请求里的 cells 以前端发来的为准（教练可能改过格子，见 plan-web 015 §2.4），服务端不比对原表。
- 服务端每周单独调一次模型（并发 ≤ 4），一周失败重试 1 次，仍失败则该周回 `{ index, error: 'PARSE_FAILED', reason }`（错误信封沿用仓内 `{ error: code }`），其余周照常返回。`reason` 必填，前端据此给教练一句人话（2026-10-22 David 追加）：
  - `MODEL_BUSY`：上游 429 / 5xx / 超时 / 网络错误；
  - `OUTPUT_TOO_LONG`：上游 `finish_reason = 'length'`（输出被截断）；
  - `BAD_OUTPUT`：返回不是合法 JSON 或 zod 校验不过（重试后仍然）；
  - `REGION_SUSPECT`：模型在输出里标明这块区域不像完整的一周（提示词里给它这个出口：`{"region_suspect": true}`）。
    响应：

```jsonc
{ "weeks": [ {
  "index": 0,
  "start_date": "2026-01-05" | null,
  "days": [ {
    "weekday": 0,                       // 0=周一 … 6=周日
    "rest": false,
    "exercises": [ {
      "name": "低杆深蹲",               // 原表写法，trim
      "sets": 4,                        // 无结构（如「4组 力竭」只有组数）照填；完全读不出 → 0
      "reps": "8" | "8+" | "30s" | "",  // 末组 amrap → 末尾「+」
      "mode": "kg" | "rpe" | "none",
      "values": ["112.5","120","120","120"],   // 逐组；规范化字符串；length = sets 或 0
      "note": "节奏 310；60%top",        // 力竭 / %top / 节奏 / 降组 / 暂停 / 读不懂的串（Q8）
      "family_guess": "squat" | "bench" | "deadlift" | null,   // 给自动新建自定义动作用
      "flags": ["note_fallback" | "inferred"]
    } ]
  } ]
} ] }
```

### 2.4 存疑标记（flags，Q12）

- `note_fallback`：有单元格内容没能结构化、被放进了 `note`。
- `inferred`：`values` 里出现了原单元格文本里**找不到**的数字（例如一个重量铺满 4 组、爬坡「80→90 +5」展开）。**服务端确定性校验**：把这一周 cells 文本里的所有数字收集起来，`values`/`sets`/`reps` 中任何数字不在其中 → 必加 `inferred`；模型自报的也保留。这一条是防模型编数的闸门，不靠模型自觉。
- 「动作名没对上」「某周没日期」由前端判断，不在这里。

## 3. 模型调用

- OpenAI 兼容 `POST {BASE_URL}/chat/completions`，`response_format: { type: 'json_object' }`，`temperature: 0`，单次超时 60s。输出用 zod 校验，不合格重试 1 次。
- 封装成接口 `PlanImportModel { outline(input): Promise<Outline>; parseWeek(input): Promise<WeekResult> }`，HTTP 实现 `DeepSeekPlanImportModel`；路由经依赖注入拿到它，测试换假实现。
- **系统提示要点**（写进 `src/services/plan-import/prompts.ts`，中文）：
  - 你在读力量训练教练手写的计划表。表格版式各不相同：可能一周占一个横向块（每天占若干列），也可能从上往下一行一个动作；日期可能是 Excel 序列已转 ISO、「W1 周一」、「第1周」或没有。
  - 识别：动作名；组×次（`4*8`、`4×8`、`4组×8`、`3x5`、`4组`）；强度：kg 重量（单值、逐组 `110/115/120/120`、`57.5/65/57.5*2` = 末值重复 2 组）、RPE（`rpe8`、`rpe` 标记 + 逐组串 `6788` = 6/7/8/8、`rpe8-9`）；`amrap`。
  - 「休息」= 休息日。同一格里「热身激活⏎…」这种非正式训练内容进 note 或忽略，不当动作。名字为空、只有组次的行 = 上一个动作的追加组（如顶组 + 退让组），合并成同一个动作的不同组值；合不了就作为同名第二个动作。
  - 力竭、`60%top`、节奏 `310`/`500`、`长暂停2s`、降组、`周二减7.5` 等无法变成逐组数值的写法 → 原样进 note，加 `note_fallback`。
  - **不得编造数字**；拿不准就留空并进 note。
  - outline 阶段：注意事项、热身说明、营养、RPE 对照表、计算器等页不是计划；多页都有计划时选日期最新的那页。
- 不发文件名；日志只记 import_id、教练 id、字符数、token 用量、耗时、结果码，**不记任何单元格内容**。

## 4. 迁移 `0076-plan-import-runs.sql`（开工先 `git fetch` 核实 0076 未被占用，被占顺延）

```sql
CREATE TABLE plan_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trainee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('file','paste')),
  input_chars integer NOT NULL,
  week_calls integer NOT NULL DEFAULT 0,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_import_runs_quota_idx ON plan_import_runs (coach_id, trainee_id, created_at);
```

（外键表名以现有 schema 为准。）只存计数，不存表格内容。纯新增表，无存量数据照护问题。`db/MIGRATIONS-APPLIED.md` 按惯例记账。

## 5. 测试 seam（先红后绿，越少越好）

1. **HTTP 路由层**（`tests/plan-imports.test.ts`，沿用现有 supertest + 测试库 helper）：注入假 `PlanImportModel`。覆盖：未配 key → status `enabled:false`、POST 404；非本人学员 404；第 4 次 → 429 且前 3 次成功才计数（422 不计）；import_id 跨教练 / 隔天被拒；某周模型失败只回该周 error 且四种 `reason` 各有一条用例；第 9 次调 weeks 被拒；`inferred` 闸门（假模型返回原文没有的数字 → 响应带 `inferred`）；请求体无文件名字段、日志无单元格文本。
2. **DeepSeek 适配器单测**：用假 fetch 断言请求形状（json_object、temperature 0、超时）、非法 JSON 重试一次。
3. **真模型评估脚本**（不进 CI）：`scripts/plan-import-eval.ts <xlsx/csv 路径...>`，本地用真 key 跑两步并打印每周识别摘要与 flags 计数，给 Opus/David 用真实样表验收。样表不进仓（仓库公开）。

## 6. 验收清单

- [ ] 三条命令绿：`npm test`、`npx tsc --noEmit`、`npm run build`（以仓内 CLAUDE.md 为准）。
- [ ] 路由测试覆盖 §5.1 全部条目。
- [ ] 评估脚本在本地跑通 `~/Downloads/邓天平.xlsx`（Monster 版式）、`~/Downloads/MeetPR-12周计划-planweb导入版.xlsx`（「W1 周一」+「4组×8」版式）、`~/Documents/training/sumo-cycle1.xlsx`（流水式）：识别出的周数、每周训练日数与原表一致；抽查 10 个动作的组×次与重量 / RPE 与原表一致，不一致的都带 flag。
- [ ] 未配 key 时启动、现有测试全部不受影响。
- [ ] 部署前 David 把 `DEEPSEEK_API_KEY` 写入国内 staging env（Opus 陪跑提醒，不入卡）。

## Out of Scope

- 截图 / PDF 识别；在线表格链接直读（网页用粘贴解决）。
- 逐组备注 / 失败组 / 退让组的结构化（继续进行备注，Q8）。
- 海外开放；隐私政策改动。
- 前端的一切（见 plan-web spec 015）。
