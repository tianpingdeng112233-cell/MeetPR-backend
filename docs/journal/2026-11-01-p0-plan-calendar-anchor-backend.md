# P0 #5：计划日期 anchor 同步（Backend）

## 范围与兼容

David 直接要求修复。基底 `a1b2a8f`（现场核实 origin/staging 与 SAE 部署镜像）。依据现行 CONTEXT 的位置式推荐日期及 specs/037-week-band-editor/SPEC.md 展示锚约定。

当 PATCH 或 days/batch 的 plan_patch 含 start_date，已有非空 anchor 随该日期同步为 ISO 周几；PATCH 即使附带旧 anchor 也按新日期同步。独立 anchor 写入和显式 null 的旧约定保留，不修改创建契约、iOS 算法、日程锁、后移或存量数据。

## 回归证据

- 开工 typecheck/lint 通过，全量基线 177 文件 / 1846 passed / 1 skipped。
- HTTP seam：PATCH 从 11/4（anchor=3）改到 11/3，旧客户端漏发和显式旧 anchor 两例先红（3 != 2）后绿；GET 回读确认。
- batch seam：周三计划改至周日，原代码 anchor=3（期望7）先红；修复后通过。null 计划继续为 null，GET 回读确认。
- 定向 plans、batch、后移共 104 项通过；最终全量及审查结果交付前追加。
- DATE 用既有 UTC 解析，不依赖进程时区。

## 交付边界

本卡不改正典 RELEASES/NEXT-RELEASE，不做全库迁移。线上目标记录仍需单独按已核实主键和旧值修复，保存备份并带并发保护；任何其他冲突记录不自动处理。

## 最终验证与审查

- typecheck、lint、format:check、build 通过。
- 首次最终全量有 1 个既有 load-types-api 用例失败（读取 tree.body.days 为 undefined，未查明偶发原因）；未改代码/测试，定向 55/55 和全量复跑 177 文件 / 1850 passed / 1 skipped 通过。不宣称修复该偶发问题。
- review-loop 独立 Standards 0，Spec 0 阻塞；Spec 明确独立 anchor 写入仍按旧契约允许，不能声称堵住一切冲突入口。
- 仓内缺少 docs/agents/issue-tracker.md，采用本地双轴审查，未运行 Matt tracker 流程。

## 同源部署产物

网页源提交 `2788b29`，基于当前线上来源 c829c11；使用 `VITE_API_BASE='' npm run build`，入口 `/assets/index-CWzN3w9o.js`。除入口 HTML 和 JS 外，字体、CSS、图标与原产物一致。随此 PR 一起交付，避免仅后端代码上线而网页继续漏发字段。
