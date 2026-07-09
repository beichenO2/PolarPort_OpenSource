# PolarPort

> **Polarisor 生态的端口分配中心** — 在 20+ 微服务并行开发时，统一回答「谁占用了哪个端口、重启后端口会不会漂移、新服务该监听哪里」。

每个项目各自 `npm start`、各自写 `.env`，端口冲突和重启漂移是本地多 Agent 开发的高频痛点。PolarPort 从 SOTAgent 分拆而来（决策 A1，2026-05-08），成为生态内端口映射的唯一事实源（SSOT）：幂等分配、心跳保活、preferred 预留，全生态通过 SDK 消费。

**GitHub:** [beichenO2/PolarPort](https://github.com/beichenO2/PolarPort)

---

## 安装

### Polarisor 生态（推荐）

```bash
git clone https://github.com/beichenO2/Polarisor.git
cd Polarisor
./install.sh infra    # 安装 PolarPort 及基础设施依赖
```

### 独立安装

```bash
git clone https://github.com/beichenO2/PolarPort.git
cd PolarPort
npm install
```

**环境要求：** Node.js ≥ 22 · better-sqlite3 native 模块需与 Node 版本匹配

---

## 设计思考

### 为什么独立成 PolarPort，而不是继续放在 SOTAgent？

端口分配逻辑独立性强、调用频率高、与 SOTA 协调语义正交。拆出后 SOTAgent 可专注服务发现与 Git 同步，PolarPort 可独立演进（预留门控、合规扫描、SDK 降级链），改动端口规则不再影响守护进程稳定性。

### 为什么用 SDK 而不是业务代码直接 curl HTTP？

SDK 内置 **30s 自动心跳**、PolarPort → SOTAgent 降级、端口 0/5 合规校验。直接 `fetch /api/allocate` 会绕过心跳，端口被标记 stale 后仍被占用，或跳过 preferred reservation 导致跨服务抢占。

### 为什么端口必须以 0 或 5 结尾，而不是任意空闲端口？

Polarisor 有端口扫描仪表盘和人工记忆需求。在 `[8000..19999]` 范围内只分配以 0/5 结尾的合规端口（约 **1200** 个候选槽），形成可预测的端口模式；外部工具（Ollama `:11434`、LM Studio `:1234`）作为已知服务 seed 登记，不参与合规扫描。

---

## 核心亮点

| 维度 | 数据 |
|------|------|
| **预注册服务** | **33** 个生态已知服务 seed（**22** 个 preferred 预留 + **11** 个按需/外部工具） |
| **HTTP API** | **9** 个端点（allocate / release / heartbeat / list / reserve / verify 等） |
| **能力注册** | **4** 个 core capability（allocate · release · heartbeat · list） |
| **心跳保活** | 默认 **30s** 间隔；超时标记 stale，同身份可复活 |
| **端口合规** | 扫描范围 **8000–19999**；preferred 必须以 **0/5** 结尾 |
| **SDK 覆盖** | TypeScript + Python 客户端；PolarPort 不可达时自动降级 SOTAgent |
| **自动化测试** | **8** 个契约 + 集成测试（Vitest + AJV schema 校验） |
| **默认端口** | **11050**（`polar-port` / PolarPort） |

---

## 架构

```
PolarPort/
├── src/
│   ├── registry.ts              # SQLite PortRegistry（allocate / release / heartbeat）
│   ├── known-services.ts        # 33 个生态已知服务 seed + preferred 预留
│   ├── server.ts                # Hono HTTP 服务（默认 :11050）
│   ├── capability-register.ts   # 向 SOTAgent 批量注册 capability
│   ├── migrations/              # preferred_reservations 表迁移
│   └── sdk/
│       ├── index.ts             # TypeScript SDK（claimPort / releasePort / listPorts）
│       ├── index.cjs            # CommonJS 兼容入口
│       └── python/              # Python SDK（polarisor_port_sdk.py）
├── contracts/
│   ├── port-api.schema.json     # HTTP 契约
│   └── examples/                # 请求/行记录示例
├── tests/contracts/             # Vitest 契约 + HTTP 集成测试
├── data/                        # 运行时 SQLite（gitignored）
├── capabilities.json            # 4 个 core capability
├── polaris.json                 # SSoT 需求定义（R1–R4）
├── PolarSoul.md                 # 设计灵魂与决策记录
```

**数据流：**

```
各微服务 ──SDK claimPort()──▶ PolarPort (:11050)
                                  │
                    SQLite ports.sqlite
                    (status / last_verified / preferred)
                                  │
              PolarProcess Watchdog ──stale sweep──▶ release + restart
```

---

## 快速开始

```bash
npm install
npm test              # 8 个契约 + 集成测试
npm run start         # 启动服务（默认 :11050；SOTAgent 不可达时 fallback）
```

在项目中使用 SDK（**唯一推荐入口**）：

```typescript
import { claimPort, releasePort } from 'PolarPort/src/sdk/index.js';

const port = await claimPort({
  service: 'my-service',
  project: 'MyProject',
  preferred: 4880,      // 必须以 0/5 结尾
  heartbeat: true,      // 每 30s 自动心跳保活
});
```

Shell 脚本可引用 Polarisor 共享脚本：

```bash
source Agent_core/scripts/port-claim.sh
PORT=$(claim_port "my-service" "MyProject" "4880")
```

> **⛔ 禁止**业务代码直接 `curl /api/allocate`。服务重启须走 [PolarProcess](https://github.com/beichenO2/PolarProcess) `POST /api/services/:id/restart`，避免僵尸进程与端口漂移。

---

## 生态依赖

| 项目 | 角色 | 是否必须 |
|------|------|----------|
| [SOTAgent](https://github.com/beichenO2/SOTAgent) | console 前端展示 + facade 桥接（`/api/ports/*` 透传本服务；端口权威在本服务） | 推荐 |
| [PolarProcess](https://github.com/beichenO2/PolarProcess) | 服务重启时释放/reclaim 端口；Watchdog stale sweep | 推荐 |
| [Agent_core](https://github.com/beichenO2/Agent_core) | `port-claim.sh` 共享脚本 | 推荐 |
| [PolarCopilot](https://github.com/beichenO2/PolarCopilot) | Hub Console 端口视图 embed | 可选 |

---

## License

MIT
