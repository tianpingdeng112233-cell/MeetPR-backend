# 009 / 网页新建草稿的训练日写入

11 月 15 日 web #171 国内上线后，教练新建四周计划收到「计划设置保存失败，请重试」。页面已经创建了草稿，第二步 POST /plans/:id/days/batch 带 expected_updated_at，而部署版本的严格 schema 拒绝了该字段。此前使用合成 API 的浏览器验收没有验证真实路由合同。

本卡在同一批量接口接受可选版本，使用已锁定的计划核对版本，写入后推进毫秒版本。旧版逐日接口不推进计划版本，条件批次还需保护被它占用的坐标。冲突返回 409，保留原日。测试范围为新建计划、初始空日保存、重新读取及防重试。未改网页、数据库结构或开关。

- 红：实际 HTTP 路由完成创建并 GET，四周 16 日批次返回 400 VALIDATION_ERROR，原因是未识别 expected_updated_at。
- 绿：同款请求 200，GET 恢复 16 个训练日，重放旧版本返回 409 且 ID 不变。另一个端点抢先创建同一天时，同坐标不会写入两份。批量接口全组 30/30。
- Chrome + 本地真实 PostgreSQL 17，使用与线上相同的网页包、全部数据库迁移和隔离的教练/学员。点击「新建计划」，选择周一二四五，创建 201、批量保存 200，刷新后为 16 练、12 休，未出现弹窗。数据库按四周分组均得到 {1,2,4,5}。计划创建、读写、查询使用真实后端；周边工作区数据用夹具。
- review-loop：Spec 独立复核新建与版本重试通过。Standards 发现旧单日 API 与条件批次相遇可能创建重复日期，已先红后绿并定向复审。显式同批删除后在原位置替换的路径也通过。

本地 typecheck、lint、format 与 build 通过。首次全量出现与计划无关的本机 HTTP 测试偶发失败（包括 coach-reviews），单独复验与最终 Linux CI 分开记录。

## 部署与验收

国内 SAE 已部署 `sha-9a6cec911837aeeac7d85537c042f392a5ab327b`（[修复 #410](https://github.com/tianpingdeng112233-cell/MeetPR-backend/pull/410)）。[CI](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43691021961)、[镜像构建](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43691021814)和[部署](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43691273234)通过。沿用已应用的 0087。部署后登录路由、健康检查通过，07:45 UTC 独立核对网页 HTML、JS、CSS 与发布包一致。

本地全量 190 个文件通过，2173 项通过、6 项跳过。Linux PR CI 与合并后 CI 均通过。新建及刷新使用本地真实 PostgreSQL 与同版前端验证，国内站点仅进行了只读资源、健康和登录路由探测。
