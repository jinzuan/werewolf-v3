# W4-B/C/D 经验库迁移、Provider 加固与 AI 上下文投影设计

## 目标

在 `ww-server` 内完成三项服务端能力：

1. 将 `src/data/experience_library/` 下的 33 个经验文件迁入服务端 AI 资产层，保留逐字节内容，并以稳定 manifest 和 SHA-256 清单校验完整性。
2. 为 AI provider 增加服务端 HTTP adapter，统一处理单 provider 并发上限、429、Retry-After、指数退避、重试、超时、结构化输出校验和确定性 fallback。
3. 在请求 provider 前按 AI 角色投影上下文，只提供该角色可见的私密事实、公开事件、规则和经验资产，不暴露全知状态或敏感配置。

旧 `shared/aiClient.ts` 保持兼容，不作为本轮服务端 adapter 的实现边界。

## 现状与边界

现有服务端调用链为：

`RoomService.driveAI -> AIOrchestrator -> AIProvider -> GameSession.dispatch`

`GameSession` 已提供：

- `snapshotFor(ViewerContext)`：按 player viewer 投影玩家身份和游戏状态；
- `eventsFor(ViewerContext)`：按 player viewer 过滤 `public_timeline`、`role_private` 和 `wolf_private`；
- `stageRevision`、`allowedActors`、`allowedActions`：服务端权威动作边界。

规则唯一来源为 `src/core/rules.ts` 的 `RULESET`。服务端 AI 不读取 omniscient spectator 投影，不读取原始 session 全状态，不读取 token 或 API key。

## 方案

### 1. 经验资产层

新增：

- `server/data/experience_library/*.md`
- `server/data/experience_library/manifest.json`
- `server/ai/experienceLibrary.ts`

33 个源文件按原文件名逐字节复制。manifest 使用稳定的文件名排序，包含：

- `version`
- `count`
- `files[].path`
- `files[].role`
- `files[].bytes`
- `files[].sha256`

manifest 不写生成时间或其他非确定性字段。loader 启动时读取 manifest，重新计算每个文件的字节数和 SHA-256，并同时校验：

- manifest 数量为 33；
- manifest 文件条目无重复；
- 磁盘文件集合与 manifest 集合完全相等；
- 每个文件的角色、字节数和 SHA-256 一致。

校验失败直接抛出带分类名称的错误，不将不完整或被篡改的经验资产送入 provider。经验选择按角色和 `stageRevision` 做稳定选择，合并对应角色经验与 `common` 经验，避免每次请求随机改变行为。

### 2. HTTP provider adapter

新增 `server/ai/httpProvider.ts`，实现现有 `AIProvider` 接口。`LegacyAIProvider` 保留原导出名，改为持有并委托 `HttpAIProvider`，从而让已有注入点自动获得新策略。

provider 配置来自 `loadAIConfig()`。provider key 为：

`apiType + endpoint + model`

同一个 key 共享并发闸门，最多同时执行 2 个 HTTP 请求；等待队列按进入顺序释放。测试可注入 `fetch`、sleep、clock，生产环境使用全局 `fetch` 和真实计时器。

请求使用 OpenAI-compatible `chat/completions` 格式，包含：

- 角色投影 system context；
- 投影后的 user context；
- 结构化 JSON 输出要求；
- 当前允许的动作和合法目标信息。

响应处理分层执行：

1. HTTP 响应必须成功或进入可重试分类；
2. 响应必须是 JSON；
3. 必须存在 `choices[0].message.content`；
4. content 必须解析为 JSON；
5. JSON 必须含 `command` 和 `reason`；
6. command type 必须属于当前允许动作映射；
7. payload 的基本结构必须符合命令类型。

错误分类至少包括：

- `rate_limited`
- `timeout`
- `network`
- `http_error`
- `invalid_response`
- `invalid_output`
- `command_rejected`

429 处理：

- 优先解析 `Retry-After` 的整数秒；
- 也支持 HTTP-date，并转换为不小于 0 的等待毫秒；
- 与指数退避 `baseDelayMs * 2^retryIndex` 取较大值；
- 最多重试 2 次，即最多 3 次 HTTP 尝试；
- 测试通过注入 sleep 验证等待值，不引入真实测试延迟。

超时使用 `AbortController`，adapter 的请求生命周期覆盖响应获取和响应体读取。重试耗尽、超时或输出非法时向 orchestrator 抛出带 `errorClass` 和 `retryCount` 的 provider 错误。

### 3. 角色上下文投影

新增 `server/ai/contextProjector.ts`，输入 `GameSession` 和 AI 请求元数据，输出 `AIContextProjection`：

- 当前 AI 的 player viewer 标识和角色；
- `snapshotFor(playerViewer)` 得到的角色可见玩家和游戏状态；
- `eventsFor(playerViewer)` 得到的可见事件，按公开事件和角色私密事件分组；
- 从 `src/core/rules.ts` 选择的稳定规则值；
- 由经验库 loader 校验并选择的经验参考；
- 当前 `allowedActions`、`stageRevision` 和 deadline。

投影只使用 `ViewerContext.kind === 'player'`。因此：

- 普通角色只能看到自己的身份；
- 狼人可看到规则允许的狼队友身份和狼私聊；
- 角色私密事件只进入对应角色；
- 公开事件进入所有角色；
- 不会出现 omniscient spectator 数据、完整角色表、原始 `GameState` 私有字段、token、API key 或完整 prompt 日志。

`AIRequestContext` 增加 `allowedActions` 和投影上下文，保留 `players` 等现有字段作为兼容的已投影数据。`RoomService` 从权威 `allowedActors` 同时传递具体动作和 command type，避免 fallback 只能按重复的 `game.night_action` 推断。

### 4. Orchestrator、fallback 与 telemetry

`AIOrchestrator` 负责一次 AI 行动生命周期：

1. 生成唯一 `callId`；
2. 构造角色投影上下文并调用 provider；
3. 校验 provider 结果；
4. 只为 provider 成功结果派发一次命令；
5. provider 失败或结果非法时生成确定性 fallback，并最多派发一次 fallback 命令；
6. fallback 派发失败后直接返回失败，不重复发送相同或替代命令，不阻塞 session 阶段推进。

fallback 按 `allowedActions` 和角色规则选择：

- 守卫：首个不违反连续守护规则的存活目标，否则跳过；
- 预言家：首个其他存活目标，否则跳过；
- 狼人：首个非狼存活目标，否则规则允许时自刀，否则跳过；
- 女巫：优先当前允许且资源可用的具体动作，否则跳过；
- 发言/投票/猎人：使用当前允许动作的固定安全值或首个合法目标；
- 无可用动作：不派发命令并返回失败。

telemetry 使用脱敏结构，记录：

- `roomId`
- `gameId`
- `playerId`
- `callId`
- `status`
- `retryCount`
- `durationMs`
- `errorClass`

adapter 和 orchestrator 不记录 prompt、响应原文、Authorization header、API key、完整角色表或 session 原始 JSON。普通日志只允许记录 provider key 的非敏感摘要、HTTP 状态分类和错误类别。

## 测试设计

新增服务端 AI/数据测试，至少覆盖：

1. 第一次返回 429，带 `Retry-After`，第二次成功；断言 sleep、重试数和成功 telemetry。
2. 连续 429 达到上限；断言只调用一次 fallback、阶段可继续、telemetry 为 `rate_limited`。
3. provider 超时；断言 Abort/超时分类、fallback 和不重复派发。
4. 非法 JSON 或非法命令输出；断言 `invalid_output`、fallback 和不发送非法命令。
5. manifest 33/33 数量、集合、字节数和 SHA-256 一致。
6. 角色投影断言：狼人私密事实仅狼可见，角色私密事实不跨角色，公开事件可见，omniscient/full role table/token/API key 不进入投影。

验收命令：

- `npm test`
- `npm run typecheck`
- `npm run server:typecheck`
- `npm run lint`
- `npm run build`

## 非目标

- 不迁移或重写旧前端 `shared/aiClient.ts`；
- 不改变核心规则和 GameSession 的命令校验；
- 不把全知监控能力暴露给 AI；
- 不新增 provider 供应商协议以外的业务动作；
- 不做与 W4-B/C/D 无关的持久化或 UI 重构。
