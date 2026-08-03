# SPEC 032 — 聊天实时通道:WebSocket 推送取代客户端轮询(服务端)

- **Status: InProgress**
- **级别**: T2(新依赖 `ws` + 跨仓契约)。**P1**(backend 合并后必部署 staging,严禁只合不部署)。
- **来源**: 教练零感知专项侦察(2026-08-03)。教练端 app 内唯一自动更新的感知是聊天
  30s 轮询;David 拍板先把聊天做成实时。APNs / 离线推送**不在本 spec**(另属每日聚合推送轨道)。
- **端**: backend(本仓)+ iOS(对端 spec 编号 **066**,在 iOS 仓)。wire 契约以本 spec §3 为准锁死。

## 0. 已核实的工程前提(侦察结论,引用即约束)

1. **链路可行**:CLB `121.40.160.241:3000` 已实测为 L4 透传——带 `Upgrade: websocket` 头的
   握手请求原样到达 Express(响应含 helmet 头 + `X-Request-Id`,无中间层改写)。
2. **单实例假设成立**:`src/jobs/scheduler.ts` 的 node-cron 全部进程内跑、无分布式锁,
   说明部署形态本就是单实例。fan-out 用**进程内 hub**,不引 Redis、不做 pg LISTEN/NOTIFY
   (在 hub 模块头部留一段注释说明这个限制与扩容路径即可)。
3. **鉴权复用**:`src/middleware/auth.ts` 的 `verifyBearerToken(header, config)` 是唯一
   token 校验事实源(HS256 + aud/iss + legacy 宽限)。它目前是模块私有——**导出复用,禁止复制逻辑**。

## 1. 目标与非目标

### 1.1 目标

- 提供 `GET /realtime` WebSocket 升级端点,登录用户长连接接收**自己参与的会话**的两类事件:
  新消息(`chat.message`)与对端已读推进(`chat.read`)。
- 消息发出后事件到达双方在线设备 < 1s(同机房内网毫秒级,验收放宽到 1s)。
- 对现有 HTTP API **零改动**(响应形状、状态码、行为全部不变)——老客户端(1.0(17) 及更早)
  继续轮询,完全无感知。

### 1.2 非目标(明确不做,别顺手做)

- ❌ APNs / 离线推送 / 桌面角标(另一轨道)。
- ❌ 聊天之外的事件类型(视频上传、训练完成等)——信封设计为可扩展,但本波只发聊天两类。
- ❌ 浏览器端(plan-web)接入:浏览器 WebSocket API 设不了 `Authorization` 头,
  届时走 `Sec-WebSocket-Protocol` 传 token——本波只在升级处理器里**留一行注释**指明该路径,不实装。
- ❌ 客户端→服务端业务消息(typing indicator 等):服务端对收到的任何非 pong 帧直接忽略。
- ❌ 消息体本身不进事件 payload(见 §3 设计理由)。

## 2. 架构与文件范围

新增(均为新文件,不动现有模块职责):

| 文件                      | 职责                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/realtime/hub.ts`     | `createRealtimeHub({ logger })`:进程内注册表 `Map<userId, Set<WebSocket>>`;`register(userId, ws)` / `unregister(userId, ws)` / `publish(userId, event)`(JSON.stringify 后对该 user 全部 socket `send`,单 socket send 失败只 log 不抛);顶部注释单实例限制与 LISTEN/NOTIFY 扩容路径                                                                                                                               |
| `src/realtime/upgrade.ts` | `attachRealtimeUpgrade({ server, hub, config, logger })`:`ws` **noServer 模式**,挂 `server.on('upgrade')`;路径必须恰为 `/realtime`(带 query 也拒),否则 `socket.destroy()`;鉴权失败回写 `HTTP/1.1 401` 裸响应后 destroy(**不完成升级**);成功则 `wss.handleUpgrade` → `hub.register` → 发 `hello`;心跳:服务端每 30s `ws.ping()`,`isAlive` 标记法清死连接(ws 官方 README 套路);`close`/`error` 时 `hub.unregister` |
| `src/realtime/events.ts`  | 事件构造器与 TypeScript 类型(`RealtimeEvent` 可辨识联合),wire 字段全 snake_case                                                                                                                                                                                                                                                                                                                                 |

改动(最小侵入):

| 文件                                | 改动                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/middleware/auth.ts`            | `verifyBearerToken` 加 `export`(签名不变)                                                                                                                                                        |
| `src/server.ts`                     | 建 hub → 传入 `createApp` → `app.listen` 拿到 `server` 后 `attachRealtimeUpgrade`;shutdown 时先 `wss.close()` + 逐 socket `terminate()` 再 `server.close()`(否则挂着的长连接会让 close 永不回调) |
| `src/app.ts`                        | `createApp` 的依赖对象加可选 `hub`(测试与未接线场景传 undefined 时所有 publish 为 no-op,用 null-object 或 optional chaining 皆可,选侵入最小的)                                                   |
| `src/routes/conversations/index.ts` | 两个发布点,见 §4                                                                                                                                                                                 |

升级请求走 `server.on('upgrade')`,**天然绕过** Express 中间件栈(helmet / rate-limit /
compression / pino-http 都不掺和)——这是设计意图,不是遗漏;`upgrade.ts` 里自己打 pino 结构化日志
(connect / auth_reject / disconnect,含 userId 与连接数)。

依赖:`ws`(runtime)+ `@types/ws`(dev)。这是 ADR-004 栈内的标准选择,无需新 ADR。

## 3. Wire 契约(iOS spec 066 依此实装,锁死)

服务端→客户端,一律单帧 JSON 文本,信封 `{ "type": string, "payload": object }`:

```jsonc
// 连接建立即发,确认鉴权通过
{ "type": "hello", "payload": {} }

// 新消息落库(含发送者自己的其他设备;客户端按 conversation_id+seq 幂等)
{ "type": "chat.message",
  "payload": { "conversation_id": "<uuid>", "seq": 42, "sender_id": "<uuid>" } }

// 对端已读推进
{ "type": "chat.read",
  "payload": { "conversation_id": "<uuid>", "user_id": "<uuid>", "last_read_seq": 41 } }
```

设计理由(评审时别翻案):

- **payload 只带指针不带消息体**:消息体的可见性裁剪(spec 024 前教练隐藏 + 029 组卡片开洞)
  全在 HTTP 读路径实现;事件带体就得在推送路径重算一遍可见性,漏算即越权。客户端收指针后
  走既有 `GET /conversations/:id/messages` 增量拉取,可见性天然正确。
- **未知 type 客户端必须静默忽略**(写进 066):这是后续把视频上传、训练完成等事件挂上
  同一通道的前向兼容口子。
- 心跳用 WebSocket 协议层 ping/pong 帧,**不占用** JSON 信封。

## 4. 发布点(精确到现有代码位置)

1. **新消息**:`POST /conversations/:id/messages` 处理器中,事务提交且
   `result.outcome === 'message'` 且 `result.created === true` 时(幂等重放 `created:false`
   **不发**),向 `conversation.coach_id` 与 `conversation.student_id` **双方** publish
   `chat.message`(发送者自己也收,覆盖多设备;seq 取落库行的 `seq`)。
2. **已读推进**:`POST /conversations/:id/read` 成功路径(200 响应前),向
   `otherParticipantId(conversation, user.id)` **单方** publish `chat.read`,
   `last_read_seq` 取本次事务实际写入的游标(注意 GREATEST 语义:若请求是旧游标被夹平,
   以落库值为准;夹平未推进时可发可不发,实装取简单路径,写测试时别断言这种边界必须静默)。

两处 publish 都在**事务 commit 之后**执行(事件先于数据可见会让客户端拉到空增量),
且 publish 抛错不得影响 HTTP 响应(hub 内已吞错,发布点无需再包 try/catch,但别把 publish
写进事务闭包里)。

## 5. 约束与红线

- **wire 全 snake_case**(camelCase-仅-auth 是历史 gotcha,别扩散)。
- **升级路径不做 rate-limit**:每连接一次握手,滥用面有限;若评审坚持,上限做「单 user
  并发连接数 ≤ 8,超限踢最旧」,放 hub 里,不引 express-rate-limit。
- **不改 `messages` / `conversation_reads` schema,无迁移**——本 spec 零 SQL。
- token 过期的长连接**不主动踢**(access token 短命,踢了客户端马上重连成本更高);
  连接建立时校验一次即可。这与现有轮询的安全边界一致(轮询场景过期 token 下一次请求才失败)。
- 环境开关:不加。通道无状态、无副作用,挂上即生效;出问题回滚 = 重新部署上一镜像
  (符合 CLAUDE.md 规则 8 的独立部署原则,客户端有轮询兜底,见 066 §降级三态)。

## 6. 测试与验收

vitest(新 `src/realtime/*.test.ts` + 对 conversations 路由测试的最小增补):

1. 无 token / 坏 token / refresh-token 冒充 → 升级被拒,socket 收到 401 后关闭。
2. 合法 token 连接 → 收到 `hello`。
3. A(学员)向 B(教练)发消息 → A、B 两条连接都在 1s 内收到 `chat.message`,
   `seq` 与 HTTP 响应一致;幂等重放(同 client_id 再 POST)**不再**触发事件。
4. B 标记已读 → 仅 A 收到 `chat.read`。
5. 断开连接后再发消息 → 不抛错、无泄漏(hub 内该 user 条目清空)。
6. 心跳:不回 pong 的僵尸连接在两个心跳周期内被 terminate(用 fake timer)。

测试基建注意:supertest 不覆盖 upgrade,这几条测试需要真 `http.Server` + `ws` 客户端
(listen 在随机端口),跟仓内现有集成测试并存即可。

人工冒烟(staging 部署后,属验收必做):`wscat -H "Authorization: Bearer <token>"` 连
`ws://121.40.160.241:3000/realtime`,另一账号 curl 发消息,肉眼确认事件 < 1s 到达。
测试账号密码在 Bitwarden,不入任何文件。

## 7. 部署与后续

- 合并后立即部署 staging(`gh workflow run deploy-staging.yml -f migrations_applied=true`,
  本波无迁移该参数照传)。部署后跑 §6 人工冒烟。
- iOS 066 的端到端验收依赖本 spec 先上 staging;两卡实装可并行,联调等部署。
- 后续扩展(不在本波):同通道加教练感知事件(视频上传/训练完成)、plan-web 接入、
  多实例 LISTEN/NOTIFY——都以 §3 信封为兼容基线。
