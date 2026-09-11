# 环境变量说明

本项目的配置主要通过环境变量注入。下面是服务端和前端用到的变量说明，按用途分组。

## 一、AI 能力（最重要，必须自备）

AI 玩家需要连接外部大模型服务，由使用者自行提供凭据与配置，**不要把这些写进代码或提交到仓库**。缺少 AI 配置时，对局的 AI 发言能力会不可用或退化。

| 变量 | 说明 |
| --- | --- |
| `WW_API_TYPE` | AI 服务类型。`local` 表示使用外部大模型地址；不设置则降级为模板 AI。 |
| `WW_API_URL` | 外部大模型的 API 地址（OpenAI 兼容格式，形如 `https://.../v1`）。 |
| `WW_API_KEY` | 外部大模型 API key。 |
| `WW_MODEL` | 模型名（拼接进上层配置使用）。 |
| `WW_AI_TIMEOUT_MS` | AI 请求超时（毫秒）。 |
| `WW_AI_NATIVE_FETCH` | 是否使用原生 fetch 发起 AI 请求（某些环境需要关闭以获得稳定代理）。 |
| `WW_ALLOW_PRIVATE_AI_ENDPOINTS` | 是否允许 AI 端点指向内网/私有地址（默认按安全策略拦截，仅测试时开启）。 |
| `WW_AI_ENDPOINT_ALLOWLIST` | AI 端点白名单（逗号分隔的可信地址）。 |

## 二、服务监听

| 变量 | 说明 |
| --- | --- |
| `WW_ENV` | 运行环境（如 `development` / `production`），影响安全策略。 |
| `WW_BIND_HOST` | 服务绑定主机地址，默认 `127.0.0.1`（仅本机访问）。想对外提供服务时改为 `0.0.0.0` 或具体网卡 IP，并配合安全组/反向代理。 |
| `WW_PUBLIC_ORIGIN` | 对外公开的源地址（用于安全策略与 CORS 判断）。 |
| `WW_CORS_ORIGINS` | 允许的跨域来源列表。 |
| `WW_DEV_ALLOW_PUBLIC` | 开发环境下是否允许绑定非回环地址（非生产才可开）。 |
| `WW_TRUST_PROXY` / `WW_TRUST_PROXY_CIDRS` / `WW_TRUST_PROXY_ADDRESSES` | 反向代理信任配置（被代理时用于正确判断来源）。 |

## 三、数据与持久化

| 变量 | 说明 |
| --- | --- |
| `WW_DATA_DIR` | 本地数据目录（房间状态、对局存档、复盘等）。部署时请指向可持久化磁盘并做好备份。 |
| `WW_SECRET_STORE` / `WW_SECRET_FILE` / `WW_SECRET_KEY` / `WW_SECRET_KEY_ID` | 敏感凭据的存储方式与密钥配置。 |
| `WW_PERSISTENCE_MAX_BYTES` | 持久化数据上限（字节）。 |

## 四、房间/对局调优（可选）

| 变量 | 说明 |
| --- | --- |
| `WW_ROOM_STARTUP_GRACE_MS` / `WW_ROOM_SWEEP_INTERVAL_MS` / `WW_ENDED_ROOM_TTL_MS` | 房间启动宽限、清理周期、结束房间保留时长。 |
| `WW_JOIN_RATE_LIMIT_CAPACITY` / `WW_JOIN_RATE_LIMIT_REFILL_PER_SECOND` | 加入房间的限流参数。 |
| `WW_RATE_LIMIT_STORE` | 限流存储后端。 |
| `WW_TEST_CONTROL_TOKEN` | 测试控制端口鉴权 token（仅测试用）。 |

## 五、部署编排（可选）

| 变量 | 说明 |
| --- | --- |
| `WW_DEPLOYMENT_NAMESPACE` / `WW_INSTANCE_COUNT` / `WW_REPLICA_COUNT` / `WW_DEPLOYMENT_REPLICAS` | 多实例/副本相关，单机部署可忽略。 |

## 六、前端（Vite 构建期）

| 变量 | 说明 |
| --- | --- |
| `VITE_WW_ENV` | 前端运行环境。公网 HTTP 部署时需设为 `development` 以允许公开访问。 |
| `VITE_WW_ALLOW_PUBLIC_HTTP` | 置为 `1` 允许前端在公网非 HTTPS 环境下访问（开发/内测用）。 |
| `VITE_V3_SERVER_URL` | 前端连接的服务端地址（形如 `http://<host>:3001`）。 |

> 说明：环境变量名以实际代码读取为准（主要见 `server/runtimeConfig.ts`、`server/ai/config.ts`）。如果你发现某项行为与预期不符，先确认对应环境变量是否已正确注入。