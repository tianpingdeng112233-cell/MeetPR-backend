# 018 — SAE 滚镜像一键化(workflow_dispatch)

- **状态**: InProgress
- **来源**: 2026-07-13 David 拍板。现状:CI 只 build+push 镜像到 ACR,SAE 部署要人手进阿里云控制台点(见 `db/MIGRATIONS-APPLIED.md` 机制备忘),每次部署都卡在"只有 David 能点"这一步。

## 目标形态

新增 `.github/workflows/deploy-staging.yml`,`workflow_dispatch` 手动触发:

1. **迁移确认门**:布尔输入 `migrations_applied` 必须勾选,否则立即失败——把"先迁移后滚镜像"的 SOP 编码进流水线。
2. **镜像存在性检查**:用既有 ACR 凭证 `docker manifest inspect`,防"合了但镜像还没构建完"的竞态。
3. **SAE DeployApplication**(aliyun CLI,SAE OpenAPI 2019-05-06)+ 轮询 `DescribeChangeOrder` 直到终态,失败/超时红。
4. **curl 冒烟**:`/health` 200 才算部署成功。
5. 尾注提醒:追加 `db/MIGRATIONS-APPLIED.md` 部署记录。

## 关键取舍(拍板记录)

- **不做 push 自动部署**:迁移是手工两步(DMS),push 即部署会把"镜像超前于库 schema"的 500 事故(2026-06-24 漂移根因)自动化放大。部署保持显式动作,只是从控制台五步变成 `gh workflow run deploy-staging.yml -f migrations_applied=true` 一条命令。
- **P 尺不变**:P0=修完立即 dispatch;P1=随下次统一 dispatch;发布节奏语义不受影响,只降低执行摩擦。

## 凭证与配置(David 一次性,均不落文件)

| 项                                                  | 位置                  | 内容                                                     |
| --------------------------------------------------- | --------------------- | -------------------------------------------------------- |
| RAM 用户                                            | 阿里云 RAM 控制台     | 新建 `gh-actions-sae-deploy`,仅编程访问,挂最小策略(见下) |
| `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` | GitHub repo Secrets   | 上述 RAM 用户的 AccessKey                                |
| `SAE_APP_ID`                                        | GitHub repo Variables | SAE 控制台 `meetpr-backend-staging` 应用详情页的 App ID  |

最小 RAM 策略:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sae:DeployApplication",
        "sae:DescribeChangeOrder",
        "sae:DescribeApplicationStatus"
      ],
      "Resource": "*"
    }
  ]
}
```

(可再收紧 `Resource` 到具体应用 ARN;首版 `*` 换取配置简单,应用只有一个。)

## 验收

- 凭证配好后首次真跑 = 部署 `sha-caf7796…`(gym-day 宽限窗,spec 017):change order 成功 + `/health` 200 + SAE 控制台镜像 tag 对得上。
- 未勾 `migrations_applied` 时 job 立即失败且报错信息指向账本。
- 部署机制备忘(`db/MIGRATIONS-APPLIED.md`)同步更新。

## 变更记录

| 日期       | 版本 | 说明 | 作者   |
| ---------- | ---- | ---- | ------ |
| 2026-07-13 | 0.1  | 初稿 | Claude |
