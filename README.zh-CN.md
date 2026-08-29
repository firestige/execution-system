# Workflow Self-Recursive — Execution System

[English](README.md) | 中文

![Workflow Self-Recursive banner](docs/assets/banner.png)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/wsr-execution)](https://www.npmjs.com/package/wsr-execution)
[![npm](https://img.shields.io/npm/v/wsr-dsh-intake)](https://www.npmjs.com/package/wsr-dsh-intake)
[![CI](https://github.com/firestige/execution-system/actions/workflows/ci.yml/badge.svg)](https://github.com/firestige/execution-system/actions)

**把每一次 Agent 对话变成一条可审计、可恢复、版本绑定的交付。**

Execution System 是 [workflow-self-recursive](https://github.com/firestige/workflow-self-recursive) 的 Execution System —— 与宿主无关的小型执行边界：它解析并校验一个**确定的** Workflow Package，把绑定信息写入**不可变的 Delivery Manifest**，在 Runner 隔离的执行上下文中协调整个交付；进程崩溃后可从最后一个持久化边界**恢复**；执行过程通过 OTLP 发出**有界观测**——观测从不控制执行。

## 交付形态

Execution System 是宿主无关的产品，不是某个插件。DSH 只是入口之一：

| 形态 | 包 | 适用 |
|---|---|---|
| **嵌入库** | `wsr-execution` | 宿主无关嵌入 —— 导入 `ExecutionApplicationFactory`，用 `create(configFile, dependencies)` 引导 |
| **DSH 插件入口** | `wsr-dsh-intake` | DeepSeek Harness 用户 —— 在对话与侧边栏中运行工作流 |
| **CLI** | `execution-config`（随 `wsr-execution`）| 配置 init / copy / validate / dump-effective |

DSH 插件是首个产品入口；每个被接纳的 Workflow Action 都在 Runner 所有、隔离的 DSH 执行上下文（`DSH-E`）中运行，绝不在 Intake 上下文（`DSH-I`）中。

## 为什么需要它

| 裸 Agent 对话的问题 | 实际会发生什么 | Execution System 如何解决 |
|---|---|---|
| 执行是黑盒 | 模型做了什么、用了哪个版本的工作流定义，事后无法核对 | 每次交付绑定一个确定版本 + SHA-256，写入不可变 Manifest |
| 中断即丢失 | 进程退出/重启后，长任务状态无处可寻 | Manifest/当前槽位持久化，`/wsr recover` 从最后持久化边界恢复 |
| 版本漂移 | 同一请求在不同时刻可能执行不同定义 | 确定的 `name@version` selector、不可变 GitHub 资产与已校验的 exact-content READY cache |
| 观测与执行耦合 | 遥测故障可能拖垮执行 | 单向、best-effort OTLP；Evidence 或遥测不可用时 Execution 继续运行 |

## 工作原理

三个 Module 承担上述职责：

- **Delivery Binding** 解析一个确定的、本地 `READY` 的 Workflow Package（selector → 校验 → 本地 `MISSING/STAGING/READY` 存储），并构造 Manifest 内容。
- **Runtime Interaction** 拥有规范工作区排他性、当前 Delivery 槽位、Manifest 持久化、Runtime 调用、恢复与最终处理。
- **Delivery Observation** 将出站有界事实映射到单向、尽力而为的 OTLP profile，但不控制执行。

默认 Source 是配置指定的 `firestige/workflow-package` GitHub Release。`implementation-workflow@0.3.0` 与 `system-design-workflow@0.3.0` 会经过下载、校验并发布到本地 READY store；它们不会嵌进任何 Execution artifact。

![架构图](docs/assets/architecture.png)


## 安装（DSH 入口，一条命令）

```sh
# 1. 批准一次 better-sqlite3 原生构建（pnpm 11）
dsh plugin --profile web config set --location=project --json allowBuilds '{"better-sqlite3":true}'
# 2. 安装 Intake 入口 —— 引擎（wsr-execution）作为其依赖自动装上
dsh plugin --profile web add wsr-dsh-intake
```

要求 Node `>=24.12 <25` 与 DSH `0.1.1-rc.2`。Core 与 Intake 版本联动（`wsr-dsh-intake@0.1.3` 依赖 `wsr-execution@0.1.3`），一次 `add` 装齐、一次 `update` 同升。

## 快速开始

1. 为插件指向持久状态文件（位于安装目录之外）：

   ```yaml
   # $DSH_HOME/profiles/web/cordis.patch.yml —— workflow-execution 行
   - id: workflow-execution
     config:
       configFile: /absolute/path/wsr-local/execution.yaml
       bindingFile: /absolute/path/wsr-local/dsh-intake-bindings.json
   ```

   用 `execution-config init <path> yaml` 初始化配置，替换全部 `__REQUIRED__` 值，并在外部 DSH credential 文件中 provision 所引用的 API key。

2. 从目标 worktree 启动 DSH Web，在对话中创建 Delivery：

   ```text
   /wsr create implementation-workflow@0.3.0
   Implement the requested change and preserve existing user edits.
   ```

3. 在同一个对话中观察进度，用侧边栏 **Deliveries** / **Current status** 面板检查绑定的 Delivery，在对话中答复多轮 Action，并用 `/wsr action finish` 结束一次交互。

## 命令

```text
/wsr list                         # 隐私安全的 Delivery 与工作区状态
/wsr create <name@version>
/wsr recover [delivery-id]
/wsr status [delivery-id]
/wsr action finish
/wsr abandon <delivery-id>
```

显式第一方 skill `/workflow-execution` 通过 DSH-I 专用工具 `workflow_execution_intake` 恰好执行一次闭环操作。

## 兼容性

| 维度 | 要求 |
|---|---|
| Node.js | `>=24.12.0 <25` |
| DeepSeek Harness | `0.1.1-rc.2`（`@deepseek-ai/dsh`）|
| Workflow Package 契约 | `agentops.workflow-dsl@1.1.0` |
| 观测契约 | `agentops.observation@1.0.0` |
| 检查点存储 | `better-sqlite3`（原生构建，经 `allowBuilds` 批准）|

## 已知限制与待办

- **开发者预览** —— `0.1.x` 是面向个人与小团队可信本地使用的 MVP candidate；可能存在破坏兼容性的变更。
- **Session/Delivery 排他绑定** —— DSH Intake 只传递 private、typed、invocation-only 的精确注册会话工作区证明；Execution 推导并持久化 canonical Git worktree，Manifest/current-slot 继续作为 Delivery/worktree 的持久权威。Session、Delivery 与被占用 worktree 均不得隐式切换、共享、抢占或超时释放。
- **观测默认关闭** —— 将 `observation.enabled` 设为 `true` 并提供 loopback OTLP base `endpoint` 即可启用 non-controlling exporter。
- **仅 DSH 交互面** —— 发行版以自带 `web` profile 为交互组装；自定义 profile 只含 `dsh-base`，不是交互式 Intake 面。

## 面向维护者

- **发布 qualification** —— 见[发布流程](https://github.com/firestige/workflow-self-recursive/blob/main/docs/guides/execution-release-process.md)。`pnpm quickstart:prepare` 一次完成两个 artifact 的构建、验证与本地 E2E 配置初始化。
- **Changelog** —— 由 `pnpm changelog:generate` 从 git history 自动生成；`pnpm changelog:check`（CI 门禁）拒绝手工篡改。
- **本地发布前 E2E** —— [指南](https://github.com/firestige/workflow-self-recursive/blob/main/docs/guides/dsh-execution-local-e2e.md)；最终 [DSH quickstart](https://github.com/firestige/workflow-self-recursive/blob/main/docs/guides/dsh-execution-quickstart.md)；[配置参考](https://github.com/firestige/workflow-self-recursive/blob/main/docs/reference/execution-configuration.md)；[DSH Intake package reference](packages/dsh-intake/README.md)。

### 直接嵌入

宿主无关嵌入从 package root 导入 `ExecutionApplicationFactory`、`DefaultExecutionApplicationFactory`、`ExecutionRequest`、`TaskPrompt` 与 configuration types。调用 default factory 的 `create(configFile, dependencies)` 是唯一 production bootstrap path。Exact DSH runtime 是 optional peer：package-root import/type consumer 无需安装它；执行当前 `dsh` Provider 时，embedding profile 必须提供 `@deepseek-ai/dsh@0.1.1-rc.2`。Release 包含 `config/schema/execution.config.schema.json`、versioned defaults/examples、compiled TypeScript declarations，以及 `execution-config init|copy|validate|dump-effective`。

## 多 Provider 2.0 候选

`execution.config@2.0.0` 不含 installation-wide Provider 或 model default。Embedding product 通过唯一 `AgentProviderFactoryRegistry` 注册任意多个 exact、immutable Agent Provider factory；duplicate identity fail closed。每个 Agent-action Role 必须在 `<canonical-worktree>/.wsr/role-provider-bindings.json` 中显式绑定 exact Provider identity/version 与 Provider-owned model coordinate。Admission 校验 Workflow required capabilities，把 factory descriptor digest 冻结进 `execution.delivery-manifest@2.0.0`，且从不做 priority selection 或 fallback。Recovery 只接受同一 descriptor，并且只为 persisted Delivery 实际使用的 Provider 启动 realm。Machine schema 见 `config/schema/execution.config.v2.schema.json`。

## 获取源码

本仓库通常作为 [workflow-self-recursive](https://github.com/firestige/workflow-self-recursive) 的 submodule 使用：

```sh
git clone --recurse-submodules https://github.com/firestige/workflow-self-recursive.git
```

单独克隆：

```sh
git clone https://github.com/firestige/execution-system.git
```

## 文档

- [Execution System 设计](https://github.com/firestige/workflow-self-recursive/blob/main/docs/systems/execution/project-execution-system.zh-CN.md)
- [概念架构](https://github.com/firestige/workflow-self-recursive/blob/main/docs/agent-architecture.zh-CN.md)
- [Workflow 组合模型](https://github.com/firestige/workflow-self-recursive/blob/main/docs/workflow-composition-model.md)
- [Execution–Evidence Interaction Contract](https://github.com/firestige/workflow-self-recursive/blob/main/docs/contracts/execution-evidence/interaction-contract.zh-CN.md)
- [规划中的第一方 LangGraph Runtime Profile](https://github.com/firestige/workflow-self-recursive/blob/main/docs/systems/runtime/first-party-langgraph-runtime-profile.zh-CN.md)

## License

[Apache-2.0](LICENSE)
