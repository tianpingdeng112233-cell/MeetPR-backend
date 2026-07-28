# SPEC 029 — 组卡片:学员把某组训练(±视频)发给教练咨询

- **Status: InProgress**
- **级别**: T2(跨三端 + 迁移 + 数据模型)。**P1**(默认档)。
- **来源**: 聊天 wave 组卡片四拍(2026-07-21/22)+ David 2026-07-27 追加拍板:训练页直达入口、
  整波插到「学员端收件口重塑」之前开工。
- **端**: backend(本仓)+ iOS(入口与发送)+ plan-web(教练侧渲染)。iOS 端侧 spec 编号预留 **062**。

## 0. 已拍板(引用即约束,不重议)

1. **方案 B** = 数字卡 + 教练就地播视频。
2. **不新增 message kind**。`ChatMessageKind` 在 1.0(14) 老包上是无 unknown 兜底的裸 String enum
   且消息数组整体解码——服务器下发第三种 kind 会让老包**聊天页+会话列表双双整屏崩**。
   组卡片走 `kind='text'` + 新列;迁移 0045 的互斥 CHECK
   (`kind='text' AND body IS NOT NULL AND attachment_id IS NULL`)**原样不动**(可追加新 CHECK,见 §2)。
3. **快照口径 = 冻结建意图那一刻**(学员在选择器里确认某组时采样;之后视频上传耗时多久、
   POST 何时真正发出,快照都不重采)。UI 文案必须写「发送这组当前的记录」。
4. **前教练完全读不到组卡片**(整条隐藏)——对 spec 024 D3 的**定向开洞**,仅限组卡片。

## 1. 目标与非目标

### 1.1 目标

- 学员从**训练页**(今日训练,已录完的组)一键「问教练」→ 冻结快照 → 进聊天补一句话发送,可附该组视频。
- 聊天内同一选择器可发起(仅列今日已录组)。
- 教练在 plan-web 与 iOS ChatUI 看到数字卡(动作名/第 N 组/重量×次数/RPE/日期),有视频则就地播放。
- 老客户端(iOS ≤1.0(14)、旧 web bundle)看到 body 降级文本,不崩不缺。

### 1.2 非目标(明确不做,别顺手做)

- 日级整份分享(被搁置的 B 楔子);教练→学员方向(服务端强制,见 §3);多组打包(D2 默认);
- 转发/引用回复/撤回;W2 APNs;学员端收件口重塑(已改排本波之后);冷启动 deep link(见 §5)。

## 2. 数据模型与迁移(migration 号**开工当天现场取**,本文用 `NNNN` 占位)

```sql
ALTER TABLE messages
  ADD COLUMN set_ref  JSONB NULL,
  ADD COLUMN video_id UUID  NULL REFERENCES attachments(id) ON DELETE SET NULL;

-- 追加约束(不动 0045 旧 CHECK):
ALTER TABLE messages
  ADD CONSTRAINT messages_set_ref_text_only   CHECK (set_ref IS NULL OR kind = 'text'),
  ADD CONSTRAINT messages_video_needs_set_ref CHECK (video_id IS NULL OR set_ref IS NOT NULL);

-- 服务 FK ON DELETE SET NULL 的引用定位(attachment 删除时免全表扫),非查询路径:
CREATE INDEX messages_video_id_idx ON messages (video_id) WHERE video_id IS NOT NULL;
```

- `ON DELETE SET NULL` 照抄本仓 **SPEC 025**(feedback.video_id,迁移 0046)的正典——iOS 仓称 spec 060,同一波:学员删视频 → 卡片降级纯数字卡,消息不消失。
- **红字禁忌(原样约束)**:`video_id` **不得**加进 `uploads/index.ts` 的 `attachmentIsReferenced`
  (否则学员永远删不掉被引用视频);iOS `sendSetRef` **不得**复用 `sendImage` 的 attachment 清理路径。
- 迁移测试须覆盖:旧行两列为 NULL、0045 旧 CHECK 原样有效、FK 删除后 SET NULL 生效、
  两条新 CHECK 与索引存在。

### 2.1 `set_ref` 快照 schema(服务端 strict 校验形状)

```jsonc
{
  "v": 1,
  "exercise_name": "低杠位深蹲", // 冻结显示名;禁止换行与控制字符(防逃逸 §3 首行边界)
  "set_number": 3, // ⚠️ 1-based 展示序号 = set_logs.set_index + 1。
  // 命名刻意避开 set_index:本仓 set_logs.set_index 是 0-based
  // (0005 CHECK >=0 实证)。⚠️ backend feedback 序列化原样回传
  // 0-based(feedback-serialization.ts:70),「第1组显示#2」的
  // 病根在哪一层喂错**尚未定位**——C0 的任务就是逐面审计并
  // 建立 per-surface fixture,不许按传言删任何 +1。
  "weight_kg": "100", // 可空;**十进制字符串**,规范形(无尾零/无多余前导零)
  "reps": 5, // 可空,整数 0..99(0 合法,失败组)
  "rpe": "8.5", // 可空;**十进制字符串**,0..10,0.5 步进(域正典)
  "day_date": "2026-07-27", // 学员 gym-day 口径
  "set_log_id": "uuid", // 轻量溯源,见 §3 校验级别
}
```

- 校验(**逐项写死,与源 schema 对齐,不得拒绝合法历史数据**):
  - `v == 1`;`exercise_name` 非空 **≤120**(对齐源 exercises 迁移 0002;上一版 64 会拒长动作名)
    且无 `\n`/控制符;
  - `set_number` 整数 **1..2147483648**(= 源 `set_index` 的 INT 上限 `2147483647` **+1**——
    上一轮写 …647 恰好排除源域最后一个值;该值仍在 Swift Int64 与 JS safe integer 内);
  - **`weight_kg` 与 `rpe` 为十进制字符串,不是 JSON number**——JS 浮点会把合法两位小数拒掉
    (`0.29*100 = 28.999…996`,`Number.isInteger` 误判 400)。规则:
    - `weight_kg`: null 或匹配 `^(0|[1-9][0-9]{0,3})(\.[0-9]{1,2})?$` 且数值 ≤9999.99
      (**ASCII 数字类 `[0-9]`,不用 `\d`**——Swift/ICU 与 JS 对 Unicode decimal digit 解释不同),
      **必须已是规范形**(无尾零:`"100.10"` → 400;无多余前导零)——首行直接逐字节引用该串,
      三端零格式化分歧;
    - `rpe`: null 或匹配 `^(10|[0-9](\.5)?)$`(0..10,**0.5 步进**——⚖️ 2026-07-27 David 域裁决:
      RPE 就是 0.5 步进,iOS 滑杆 step 0.5、E1RM 表 0.5 步斜率、算法 rpeInc 0.5 全域一致;
      backend `RpeSchema` 的 0.1 松校验是**校验债**而非域真相,评审 R2 按它对齐是错的。
      规范形:整数无 `.0`,半步恒 `.5`),同规范形要求;
    - 解析用正则捕获组转整数 minor units(weight×100、rpe×10),**禁止二进制乘法判精度**;
  - `reps`: null 或整数 0..99(与源 `sets.ts` 一致,0 合法——失败组);
  - `day_date` 合法日期;**未知字段拒绝**(strict)。失败 → 400 `VALIDATION_ERROR`。
  - golden fixtures 必须覆盖:全 null、各单项 null、weight **`"0.29"` 与 `"1.15"`**(浮点陷阱值)、
    非规范形拒绝(`"100.10"`/`"08"`/rpe `"8.0"`)、**rpe `"8.3"` 拒绝**(0.1 值,域外)、
    0 值(reps 0)、边界(`"9999.99"` / rpe `"10"`)。

## 3. 写路径(POST /conversations/:id/messages 扩展)

- 新形态:`{kind:'text', body, client_id, set_ref?, video_id?}`。
- **方向强制(服务端,不靠客户端隐藏入口)**:`set_ref` 存在时 `sender` 必须 `== conversation.student_id`,
  否则 403 `AUTHORIZATION_FORBIDDEN`。教练发普通文本/图片不受影响。
- **body 一致性契约(堵跨版本欺骗面)**:老包看 body、新端看卡,两者必须说同一件事。
  - 定义**机械化首行**(唯一规范格式,实装卡附 fixture):
    `[训练分享] {exercise_name} 第{set_number}组 {weight}×{reps} @RPE{rpe} ({day_date})`
    - 可空字段的缺省形态逐一定义:weight 缺 → `-kg`;reps 缺 → `×-`;rpe 缺 → 整段 ` @RPE…` 省略;
      **weight/rpe 直接逐字节引用 §2.1 的规范形字符串**(规范性由写路径校验保证,
      首行生成端不再做任何数值格式化);不含前导/尾随空格;字段间单空格。
  - `body` 必须**恰为首行**,或以 `首行 + "\n"` 开头,后缀为学员自由备注。**整个 body 沿用既有上限 4000**(`conversations/schemas.ts:16`,
    按 JS string length 即 UTF-16 code units 计——上一版写 ≤2000 是错的);不另设备注上限。
  - 服务端由 `set_ref` **重算预期首行并比对**;不一致 → 400 `VALIDATION_ERROR`。**不落库改写**。
  - 新客户端渲染卡片 + 后缀备注;旧客户端/未知版本渲染整个 body。
- `set_log_id` 校验级别(**轻量溯源**,快照值不回查):UUID 合法、`set_logs` 行存在且
  `student_id == sender`,否则 400。**不校验快照数值与该行当前值一致**——冻结语义,行后续被改属正常。
- `video_id`:仅当 `set_ref` 存在;owner == sender、kind == `set_video`、状态 == **`ready`**
  (照抄图片路径 `conversations/index.ts:516` 的既有枚举;上一版 spec 写 completed 是错的);
  **且 `attachments.set_log_id == set_ref.set_log_id`**——「附该组的视频」是产品语义,
  不允许把别组视频挂上来。违反 → 400 `CHAT_INVALID_ATTACHMENT`。
- 与 `attachment_id`(图片)互斥,语义不变。
- **事务顺序(照抄图片路径 `index.ts:516` 的既有模式,防「查完 ready 后被删」竞态冒 500)**:
  ① canonical 检查 → ② 幂等既有行查询(**命中即返回既有消息,不重新校验 payload**,024 既有语义,
  body/set_log/video 校验只对新建)→ ③ 对 video attachment `SELECT … FOR UPDATE` →
  ④ 锁内校验 owner/kind/ready/set_log_id → ⑤ 锁 conversation、分配 seq、插入、提交;
  attachment 行锁持有到 message 插入完成。
- 幂等沿用 `(conversation_id, sender_id, client_id)`;**clientID 建意图时 mint 一次并全程复用**
  (评审必修时序②)。

## 4. 读路径 — 统一 viewer predicate(拍板 4 的完整闭环)

**定义一次,处处引用**:

```
visible(viewer, message) =
  message.set_ref IS NULL
  OR viewer == conversation.student_id
  OR (viewer == conversation.coach_id AND canonicalPairMatches(conversation))
```

- canonical 判定**复用 024 现有实现**,不新写:`resolveCanonicalAcceptedBond(student_id)`
  (`responded_at DESC NULLS LAST, submitted_at DESC, id DESC`)+ `canonicalPairMatches`
  (`conversations/index.ts:240`)。遗留多 accepted 数据下与 024 选出同一个「现任」。
- predicate 必须应用到**全部九处**,漏一处即侧信道:
  1. `GET messages` 行集(含 `has_more` 的多取一条);
  2. `unread_count`;
  3. `last_message` / `preview`;
  4. **`last_message_at`**(现值直取 conversation 全局列 `index.ts:232`,会暴露隐藏卡时间——
     对前教练回退为「最后一条可见消息的 created_at」,可空);
  5. **会话列表排序**(同上,按 viewer 视角的 last_message_at 排,防隐藏卡把前教练的旧会话顶上来);
  6. `my_last_read` 与 7. `other_last_read`(现值精确 join 原消息 `index.ts:105`——wire cursor
     **投影**为「不大于原始 seq 的最后一条可见消息」;原始 seq 保留在库,只投影 wire);
  7. `meta.other_last_read`(messages 响应内,同投影);
  8. **`POST /read`**:前教练提交隐藏卡 message_id → 400 `CHAT_INVALID_CURSOR`(既有错误码)。
- **seq 空洞口径**:前教练视角 seq 允许缺号;分页协议无碍(`since_seq`/`before_seq` 是比较,
  `has_more` 靠多取一条)。**测试与走查断言从「严格连续」放宽为「无重复、单调递增」**。
- wire 每条消息新增可空 `set_ref`(原样)与 `video_url` + `video_expires_in`。逐字段写死:
  - `video_id` 存在且 OSS 可用 → `video_url` 现签、`video_expires_in = 900`(照 image 模式);
  - attachment 已删(FK 置 NULL 后)→ `set_ref` 保留,`video_url = null` **且** `video_expires_in = null`;
  - `video_id` 尚在但 OSS 未配置 → 两者同为 null(**不是** url null + expires 900 的混合态)。
  - `video_id` 本身永不下发。
- 含 `set_ref` 消息的 `preview` 服务端固定 `"[训练分享]"`(照 `"[图片]"` 模式,前端不二次本地化)。
- **实装形态**:canonical 判定收敛为单一 `VisibilityContext`,粒度是**每会话**而非每请求——
  单会话端点 = 每请求每会话算一次;`GET /conversations` 列表 = **批量解析出
  `conversation_id → showSetRefs` 映射**(同一教练的一次列表可同时含现任与前任学员的会话,
  共用一个布尔要么泄漏要么误隐藏)。九处查询 helper 全部接收该 context,
  **禁止九处各自复制 canonical 逻辑**;测试按「学员 / 现任 / 前任」三列矩阵组织,
  **必须含「同一教练单次列表同时有现任会话 + 前任会话」的混合案例**。

## 5. iOS 端(卡群 C2a-c;spec 062 展开,此处定契约)

- **入口**:训练页已录完组行尾「问教练」;聊天 composer「+」→「分享今日训练」→ 同一选择器
  (仅今日已录组)。无 active 绑定 → 入口不出现(展示层;真正的门在 §3 服务端)。
- **会话懒创建**:不得假设会话已存在。active coach 取自学员既有绑定态;进入聊天前调
  `POST /conversations {other_user_id: coachId}`(024 既有 get-or-create,幂等)。
- **路由**:普通 in-app route(训练页 → 聊天页,组卡待发区就位)。**冷启动 deep link 不在本波**。
- **跨导航持有者**:draft、mint 好的 `client_id`、上传意图,统一归 session 级 `ChatSendCoordinator`
  (评审必修时序①):视频上传中**发送按钮不置灰**,意图订阅上传事件流传完自动发;
  sheet dismiss / gym-day 翻篇不丢;logout 可取消。
- **渲染**:ChatUI 卡片视图;iOS 教练端卡上视频**可播**,复用 feedback 视频播放件,
  URL 过期走单条重取续签(`before_seq=seq+1&limit=1`,与 plan-web §6 同)。
- **解码韧性**:`set_ref` 在 Swift 侧必须**局部 lossy decode**(`try?` 容器级)——
  `decodeIfPresent` 遇形状不兼容仍会 throw,会炸整个消息数组。v2 卡夹在数组中 → 仅该卡降级纯文本。
- 降级文本按 §3 机械首行生成(与服务端比对口径逐字节一致,fixture 共享)。

## 6. plan-web 端(卡 C3)

- 数字卡渲染(字段直取 `set_number`,**不做任何 ±1**);`video_url` → 卡上播放,弹窗复用 spec 060 W2
  形状(单视频,无 prev/next);过期续签复用图片模式,**显式 `before_seq=seq+1&limit=1`**(缺 limit 默认回 30 条)。
- 未知 `set_ref.v` → 该卡降级渲染整个 body(纯文本);消息数组与会话页不受影响。
- 轮询/已读/限流零改动。

## 7. 兼容矩阵(全部进验收,缺一不收)

| 场景                                         | 预期                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| iOS 1.0(14) 真包收 v1 卡                     | 不崩;聊天页与会话列表渲染 body 文本与 `[训练分享]` 预览                           |
| **旧 plan-web bundle**(当前已部署版)收 v1 卡 | 按 text body 显示,无空消息                                                        |
| 新 iOS / 新 plan-web 收 `set_ref.v=2`        | 仅该卡降级文本;消息数组/会话页完整(iOS 用 lossy decode 测「v2 卡夹在普通消息中」) |
| 新服务端收旧客户端普通 text/image            | 行为不变(仅响应多可空字段)                                                        |
| **部署顺序**                                 | backend(含隐私闭环)先上;客户端发卡能力后放。**C1 未含 §4 闭环前不得部署**         |

## 8. 验收标准(跨端硬项;各卡另带机械闸)

1. 老包兼容矩阵 §7 全绿(1.0(14) 用真包回归,不许只在新代码自证)。
2. 冻结:发送后改/删该组记录 → 卡片数值不变;删视频 → 降级数字卡,消息仍在。
3. 幂等:断网重试/超时重按 → 服务端恰一条(照 2026-07-27 走查 20 的验法)。
4. body 一致性:篡改 body 首行(与 set_ref 不符)→ 400;首行 + 备注 → 通过且新端正确析出备注。
5. 方向与写权限三分:**现任教练**发普通文本/图片不受新约束影响;**现任教练**携 `set_ref` →
   403 `AUTHORIZATION_FORBIDDEN`(方向错);**前教练**(解绑后)发**任何**消息 →
   403 `CHAT_BIND_REQUIRED`(024 既有口径,`index.ts:486` 发送前重查 canonical,**不得放宽**)。
6. 前教练:§4 九处全部按 predicate 过滤,含 `/read` 提交隐藏 id → 400;现任与学员完全不受影响。
7. **组号 fixture:源 `set_logs.set_index = 0` → 快照 `set_number = 1` → iOS 训练页、卡片、
   plan-web 三处都显示「第 1 组」**。
8. 视频归属:提交别组视频的 `video_id` → 400 `CHAT_INVALID_ATTACHMENT`。
9. **红线负向闸(iOS)**:发送成功、发送失败、sheet dismiss、logout 取消四条路径下,
   断言**均不调用** `sendImage` 的清理/DELETE 路径(spy 级机械验收,不接受纯文字禁令)。

## 9. 分卡(每卡一个可 review 的原子 diff)

| 卡          | 级  | 端       | 范围                                                                                                                                                                                                                                                                                                                                             | 依赖                     |
| ----------- | --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| **C0 前置** | T1  | iOS      | **组号口径统一**:建立三端 fixture(源 0-based → 展示 1-based);审计并修正「喂 1-based 值进 +1 显示组件」的路径(`HistoryEntriesView`/`SetReadOnlyCell` 及 feedback wire 消费处);落 release/1.0。⚠️ 不是无脑删 `+1`——源是 0-based 时 `+1` 是正确转换                                                                                                 | 无,**先行合并**          |
| **C1**      | T2  | backend  | 迁移 `NNNN` + 写路径(§3 全部校验)+ 读路径 + **§4 九处隐私闭环**(与读写同卡原子上线,不拆——拆开会造出「任何 API 客户端可写卡、前教练可全读」的可部署中间态)                                                                                                                                                                                        | 无                       |
| **C2a**     | T1  | iOS      | **共享层**:`SetRefV1` 模型 + canonical formatter(机械首行,golden fixtures 与 backend 共享)+ **源值规范化**(set wire 常见 `"100.00"`/`"8.0"` → intent builder 解析为 minor units 后输出规范形 `"100"`/`"8"`;服务端只校验不代规范化;fixture 含 `"100.00"→"100"`、`"8.0"→"8"`)+ `ChatSendCoordinator` 扩展(意图/client_id 单次 mint/上传订阅自动发) | C0                       |
| **C2b**     | T1  | iOS      | 训练页入口 + 选择器 + 会话懒创建 + in-app 路由 + 发送 UI                                                                                                                                                                                                                                                                                         | **C1、C2a**              |
| **C2c**     | T1  | iOS      | ChatUI 接收渲染 + lossy decode + 教练端播视频                                                                                                                                                                                                                                                                                                    | **C1、C2a**(与 C2b 并行) |
| **C3**      | T1  | plan-web | 组卡渲染 + 就地播视频 + 续签 + v 降级                                                                                                                                                                                                                                                                                                            | C1                       |
| ~~C4~~      | —   | —        | **已并入 C1**(BLOCKER 7:隐私闭环不得晚于读写部署)                                                                                                                                                                                                                                                                                                | —                        |

- C2a 先行;**C2b 与 C2c 可并行**(formatter 唯一 owner 是 C2a);C3 与 C2 系并行。发卡能力(C2b)必须晚于 C1 部署(§7 矩阵)。
- **迁移取号纪律**:C1 开工当天 `gh pr list --json number,files` + `ls db/migrations/` 现场取;
  当前在飞:0043(#77/#79 争用)、0047(#95)、0050(#110);0049 疑被 is_test 标记占用——都不许撞。

## 10. 待 David 拍板(不阻塞评审,按默认走)

- ~~D1 训练页入口形态:默认每组行尾「问教练」~~ → ⚖️ **2026-07-28 David 实机截图后修订**:
  行尾按钮太挤,撤;改为 **hero 卡片常驻单一「问教练」入口**(有今日已录完组且 active 绑定时显示),
  点击弹选择器 sheet(列今日已录组:动作/组号/重量×次数/RPE/视频标记,**单选**,默认选中最近录完
  的那组)→ 既有确认卡流程。聊天内 composer「+」共用同一选择器。
- D2 一条消息一组(**维持默认,D1 修订时未翻案**);多组打包不做。

## 评审处置

- R1(2026-07-27,11 BLOCKER + 1 nit):全部采纳。要点:body 机械首行契约堵欺骗面;
  `set_index`→`set_number` 斩断同名异义(现场核实 0005/sets.ts 证实源为 0-based,
  C0 从「删 +1」改为「口径统一」);方向服务端强制;video 状态改 `ready` + 组归属校验;
  隐藏闭环扩到九处含 `/read` 与排序;canonical 复用 024 函数;C4 并入 C1;
  兼容矩阵补旧 web/v2 lossy/部署顺序;C2 拆三卡补懒创建与路由契约;追加两条新 CHECK;
  补 Status 头。nit(索引理由改为服务 FK SET NULL 定位)已改。

- **终审修订(2026-07-27,David)**:RPE 恢复 **0.5 步进**。评审 R2-B1 的「对齐源 0.1」被域裁决
  推翻——Codex 把 `RpeSchema` 的松校验当成域真相,属代码考古误判;分享路径按域收紧不算
  「缩窄源域」,因为域本来就是 0.5。`RpeSchema` 收紧另开卡,不混本波。
