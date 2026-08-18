# 043 — S3 兼容存储后端(海外线 R2,⚖️08-17 拍板 A)

- **状态**: InProgress(2026-08-18 起草;⚖️David 授权离线两日全线自主,PR CI 绿自合)
- **来源**: ⚖️08-16/17 架构拍板——海外自建 DO NYC + Cloudflare R2,海外数据不走阿里云;
  可换性四原则(存储只走 S3 接口/SQL 原味/配置全 env/不碰私有服务)。
- **级别**: T2(单模块 services+config,零迁移;国内 OSS 行为零变化红线)

## 目标

`OssService` 接口(src/services/oss.ts)获得第二个实现:S3 兼容后端(aws-sdk v3),按 env 选择。
海外部署配 R2 即用(分片上传/presigned GET/控制面全套);国内部署零感知——env 不配 S3 时
一切与现状逐字节一致。

## 设计

1. **接口不动**:`OssService` 七个方法语义原样;新文件 `src/services/s3-storage.ts` 实现
   `createS3StorageService(options): OssService`(@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner,
   这是仓库首个新增运行时依赖,ADR 一并落:`docs/adr` 若无此目录则按 CLAUDE.md 指到 Brain 的惯例,
   在 spec 本文件 §ADR 节内记决策即可,别为此新开体系)。
2. **env 选择器**(config.ts,全部 optional,fail-safe):
   - `STORAGE_BACKEND`:`'oss' | 's3'`,缺省 `'oss'`(=现状,国内零变化的保证);
   - `'s3'` 时要求:`S3_ENDPOINT`(R2=`https://<account-id>.r2.cloudflarestorage.com`)、
     `S3_REGION`(R2 用 `auto`)、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`;
     不齐则与 OSS 缺配同语义(uploads 503 UPLOADS_NOT_CONFIGURED)。
   - server.ts 组装点按 `STORAGE_BACKEND` 选 `maybeCreateOssService` / `maybeCreateS3Service`。
3. **方法映射**(R2 全兼容 S3 API):initiate=CreateMultipartUpload(带 Content-Type);
   signPartUrls=每 part 的 presigned UploadPart(⚠️与 OSS 同纪律:客户端 PUT 不带 Content-Type,
   S3 分片签名本就不含该头,天然一致);complete=CompleteMultipartUpload(etag 原样传,
   R2 的 etag 带引号——**与客户端回传格式的一致性要有测试钉住**,iOS 侧存的是响应头 ETag 原文);
   abort=AbortMultipartUpload(NoSuchUpload 吞掉保持幂等,S3 错误码 `NoSuchUpload`);
   signGetUrl=presigned GetObject;headObject=HeadObject(404→null,取 ContentLength);
   deleteObject=DeleteObject(404 幂等)。
4. **accelerate 面**:`accelerationEnabled` 恒 false,`OssSignOptions` 忽略(spec 041 是 OSS 专属;
   R2 走 CF 边缘天然全球加速,无需分流)。判据查询(phone IS NULL)在 service 层之上,不受影响。
5. **TTL 不变量**:part 1h / GET 15min 常量在路由层,不动。

## 不在范围

- DO 基建本体(PG/App Platform/DNS,基建线另行);部署 workflow(另一张卡);
- 视频转码/CDN 域名定制(禁转码纪律不变);国内切 S3(永不,防复活)。

## 验收

1. **国内零变化红线**:`STORAGE_BACKEND` 缺省时 server 组装与现状逐字节一致;全量既有测试绿。
2. 单元测试(mock S3 client,与 oss.test.ts 同法):七方法全覆盖——分片签名 URL 形状/复数 part、
   complete 的 etag 透传(带引号格式)、abort 幂等吞 NoSuchUpload、head 404→null、
   GET 签名含过期参数;config 选择器三态(缺省 oss/s3 齐配/s3 缺配 503)。
3. `pnpm test` 全绿 + typecheck/lint/format;新依赖 lockfile 干净(仅 @aws-sdk 两包及其传递依赖)。
4. 对真 R2 的端到端实证不在本卡(基建线拿到 env 后在海外 staging 全链实证里做)。

## §ADR:新增 @aws-sdk 依赖

仓规「新依赖须问」:David 已拍板 A(R2)且授权离线自主,S3 SDK 是该拍板的必然推论;选官方
@aws-sdk v3 模块化包(仅 client-s3 + s3-request-presigner)而非第三方轻量库,理由=R2/S3/Spaces
官方兼容性目标 + 签名 v4 正确性不自实现。记录于此,回来后如有异议可换。
