# 041 — 海外:OSS 传输加速签名(Global track 用户)

- **Status: InProgress**(2026-08-15 起草;海外关键路径④硬阻塞项,PR 停在终审)
- **级别**: T1(单模块 ≤5 文件,无迁移,无新依赖,env 总闸保护默认行为)

UK 实测经公网直连杭州桶上传 20KB/s,首分片永远超时——海外教练/学员真机测试(关键路径④)
被视频上传硬阻塞。阿里云 OSS 传输加速(transfer acceleration)让客户端就近接入边缘节点,
经内部骨干网回源桶;接入方式=把 presigned URL 的 host 从 `oss-cn-hangzhou.aliyuncs.com`
换成加速域 `oss-accelerate.aliyuncs.com`,签名算法不变(本地 HMAC,零额外往返)。

**计费边界即设计边界**:加速流量单独计费(约 ¥0.5/GB),只有**走加速域名的请求**产生费用。
因此不能全局切换——境内用户继续走默认域零增量成本,只给海外用户签加速 URL。

## 判据:谁拿加速 URL

⚖️08-14 已拍板:Global track 无手机号(SiwA/邮箱/Google 三通道,见 spec 039/040)。
因此**请求发起者 `users.phone IS NULL` ⇔ Global track 用户 ⇔ 签加速域**。

- 判据取**当前认证用户**(URL 是签给请求者用的:学员上传、教练/学员播放,各看各的 phone),
  不看资源 owner——Global/国内两个 track 不互绑,不存在跨 track 签发场景。
- `req.user` 只有 JWT payload(id/role),phone 需按 `req.user.id` 查一次 `users` 表(PK 查询)。
  实装可自行决定放 helper 还是 route 内联,但**不改 token claims**(W1 已上线,token 形状冻结)。

## Scope

- `src/config.ts`:新增可选 env `OSS_ACCELERATE_ENDPOINT`(如 `https://oss-accelerate.aliyuncs.com`)。
  **未配置 = 功能整体关闭,一切行为与现状逐字节一致**(部署顺序保护:桶开关未开前不配 env)。
- `src/services/oss.ts`:`OssService` 的**签名类方法**(`signPartUrls` / `signGetUrl`)支持按调用方
  要求签加速域(第二个 ali-oss client 指向加速 endpoint,或等价实现)。**控制面方法**
  (`initiateMultipartUpload` / `completeMultipartUpload` / `abortMultipartUpload` / `headObject` /
  `deleteObject`)是 server→OSS 同区调用,**永远走默认 endpoint**,不受本 spec 影响。
- 签名 URL 的四个下发点接上判据:
  - `src/routes/uploads/index.ts`:分片 PUT part URLs + 附件 GET URL
  - `src/routes/conversations/index.ts`:聊天图片/视频 GET URL
  - `src/routes/video-markers.ts`:标注锚帧 GET URL
- 测试:见 §验收。

**不在范围**:桶侧「传输加速」开关(阿里云控制台人工,David;AK 在 Bitwarden 不入任何文件)、
SAE 配 env(合并部署时随手配,但必须在桶开关之后)、iOS/plan-web 客户端(presigned URL 对
客户端透明,零改动)、按地理位置/延迟的动态选路(过度设计,不做)。

## 约束(既有纪律,逐条守)

- TTL 不变量:part URL 1h / GET 15min(spec 004,`do not extend` 注释在场,别动)。
- 分片 PUT 签名**不带 Content-Type**(既有 gotcha:客户端 PUT 不发该头,签了会 403)。
- `exactOptionalPropertyTypes` 纪律照守(config 可选键别赋 undefined)。
- 加速判据不得引入新错误面:用户不存在 → 401(与既有 auth 面一致);phone 查询本身失败 →
  **降级为默认域签名**并 warn 日志(加速是优化;瞬时 DB 抖动若映射成 401 会把客户端踢下线)。

## 验收

- `pnpm test` 全绿,新增覆盖至少:
  1. env 未配 → 所有签名 URL host 与现状一致(国内、Global 用户皆然);
  2. env 已配 + 请求者 `phone IS NULL` → part URLs 与 GET URL host 为加速域;
  3. env 已配 + 请求者有 phone → host 仍为默认域;
  4. 控制面方法(initiate/complete/head)在 env 已配时仍走默认 endpoint。
- 路由层用现有 fake OssService 模式(仓规:只在网络/DB 边界 mock)。

## 部署序(记录用,不属实装)

1. David:控制台开 `meetpr-videos-prod` 桶传输加速开关(即时生效,对默认域零影响);
2. SAE 配 `OSS_ACCELERATE_ENDPOINT=https://oss-accelerate.aliyuncs.com`,部署本 PR;
3. UK 侧真机复测上传吞吐(关键路径④门槛)。
