# WSR DSH Intake

[![npm](https://img.shields.io/npm/v/wsr-dsh-intake)](https://www.npmjs.com/package/wsr-dsh-intake)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)

**在 DeepSeek Harness 对话中运行版本绑定、可审计的 Agent 工作流。**

这是 [Workflow Self-Recursive Execution System](../..) 的 DeepSeek Harness 入口：把对话变成交付（Delivery）——解析一个确定的 Workflow Package，绑定不可变 Delivery Manifest，并在 Runner 所有、隔离的执行上下文（`DSH-E`）中运行工作流，绝不在 Intake 上下文（`DSH-I`）中。引擎（`wsr-execution`）作为本插件的依赖自动安装。

## 你能得到什么

- **侧边栏面板** —— *Deliveries* 与 *Current status*：只读控制面查询（无需聊天命令）。
- **聊天命令** —— `/wsr create`、`/wsr recover`、`/wsr action finish`、`/wsr abandon`，时间线中渲染 Workflow 节点。
- **显式 skill** —— `/workflow-execution` 通过 DSH-I 专用工具 `workflow_execution_intake` 恰好执行一次闭环操作。
- **隔离执行** —— 每个被接纳的 Workflow Action 都在 Runner 所有的 DSH 执行上下文中运行；Intake 从不控制执行。
- **崩溃恢复** —— Manifest/当前槽位与私有绑定持久化；重启后从最后持久化边界恢复。

## 安装

```sh
# 1. 批准一次 better-sqlite3 原生构建（pnpm 11）
dsh plugin --profile web config set --location=project --json allowBuilds '{"better-sqlite3":true}'
# 2. 安装本入口 —— 引擎（wsr-execution）作为依赖自动装上
dsh plugin --profile web add wsr-dsh-intake
```

要求 Node `>=24.12 <25` 与 DSH `0.1.1-rc.2`（发行版以自带 `web` profile 为交互组装；自定义 profile 只含 `dsh-base`，不是交互式 Intake 面）。Core 与 Intake 版本联动，一次 `add` 装齐、一次 `update` 同升。

## 配置

为插件指向位于安装目录之外的持久状态文件：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml —— workflow-execution 行
- id: workflow-execution
  config:
    configFile: /absolute/path/wsr-local/execution.yaml
    bindingFile: /absolute/path/wsr-local/dsh-intake-bindings.json
```

- `configFile` 是规范 `ExecutionInstallationConfig`；插件原样传给公共 bootstrap，不解析或复制 Provider、credential、Source、OTLP 设置。用 `execution-config init <path> yaml` 初始化，替换全部 `__REQUIRED__` 值，并在外部 DSH credential 文件中 provision 所引用的 API key。
- `bindingFile` 存放适配器私有的 DSH 会话-交付关联。

不启动工作流即可验证组合后的 profile：`dsh --profile web --dump-config`（不得包含 API key），然后 `dsh web`。

## 快速开始

从目标 worktree 在对话中创建 Delivery：

```text
/wsr create implementation-workflow@0.3.0
Implement the requested change and preserve existing user edits.
```

在同一个对话中观察进度，用侧边栏 **Deliveries** / **Current status** 检查绑定的 Delivery，在对话中答复多轮 Action，并用 `/wsr action finish` 结束交互。

## 命令

```text
/wsr list                         # 隐私安全的 Delivery 与工作区状态
/wsr create <name|name@latest|name@version>
/wsr recover [delivery-id]
/wsr status [delivery-id]
/wsr action finish
/wsr abandon <delivery-id>
```

侧边栏面板是默认用户入口；`list` 与 `status` 保留为兼容/自动化面。显式 skill `/workflow-execution` 选择一个闭环操作并恰好调用一次 `workflow_execution_intake`。当前 DSH turn 的文本与图片即 Workflow prompt；绑定 Action 等待输入时的普通答复会路由到该 Action。

## 展示边界

侧边栏面板只展示只读控制面结果。聊天时间线中，交互命令以精确的原生用户消息进入宿主 turn；Intake pre-step 在任何 DSH-I 模型请求前消费该 turn。确认、运行中状态、Action 输出/输入请求、有界错误与未成功的终态结果渲染为 assistant 风格 Workflow 节点，但不声称模型作者身份；成功终态标记保持为持久控制面事实，但不在聊天中展示。工具名、调用标识与参数结构永不进入展示载荷。两个界面都不创建 assistant 消息、不控制 Execution。畸形展示文本以 `WSR_PRESENTATION_INVALID` 替代，不裸显。

## 工作区权威

插件从不替换进程 cwd。在 [#93](https://github.com/firestige/workflow-self-recursive/issues/93) 过渡期，需要选择 worktree 的操作使用调用会话的精确注册工作区；仅当调用 Agent 是当前活跃实例、DSH workspace registry 将会话 `cwd` 解析为绝对规范工作区、且该工作区记录会话为成员时才被接受——否则返回 `DSH_INTAKE_WORKSPACE_UNAUTHORIZED`。该权威是调用级且精确的；不接纳公共父路径或兄弟路径。[Issue #94](https://github.com/firestige/workflow-self-recursive/issues/94) 负责后续由 Delivery 选择 worktree 及其独立生命周期。

## Model Experience

### `workflow_execution_intake` 工具 —— 常量目录项

#### 模型看到什么

工具无条件注册在 DSH-I 工具目录上。模型看到名称、描述「Invoke exactly one closed Workflow Intake operation for the current DSH-I turn.」及参数 `operation`（enum `list | create | recover | status | action-finish | abandon`）、`selector`（仅 `create` 必填）、`deliveryId`（仅 `abandon` 必填）。其结果渲染为序列化的 intake presentation；工具名、调用标识与参数结构永不进入展示载荷。

#### Token 影响

常量。无论是否使用，schema 与描述都占据每次 DSH-I 请求的工具目录；没有模式切换增删该条目。

#### KV Cache 影响

稳定。工具目录的 schema 部分在请求间不变，不失效可复用前缀。

### `/workflow-execution` skill —— 条件性，仅用户显式调用

#### 模型看到什么

该 skill 是 `disable-model-invocation: true` 与 `user-invocable: true`：模型不能自行调用；用户输入 `/workflow-execution` 时指令进入上下文，引导恰好一个闭环操作经 intake 工具执行。未使用时零贡献。

#### Token 影响

条件性。指令仅在用户显式调用时出现。

#### KV Cache 影响

条件插入。调用在节边界插入指令；否则前缀不变。

### `/wsr` 命令 —— 记录为用户输入，在模型之前被消费

#### 模型看到什么

交互命令以精确的原生用户消息进入宿主 turn（`recordInput: true`）；Intake pre-step 在任何 DSH-I 模型请求前消费该 turn，因此模型不回答命令本身。绑定 Action 等待输入时的普通答复路由到该 Action，而不是开启关于它的新模型 turn。

#### Token 影响

记录的用户消息是请求输入的一部分；命令的内部生命周期与展示节点是 UI 事件，永不进入模型上下文。

#### KV Cache 影响

仅追加。记录的消息追加到请求；不替换更早的 token。

## 安全与免责

- **社区项目** —— Workflow Self-Recursive 是独立社区项目，与 DeepSeek AI 无隶属关系、未获其背书。
- **凭据** —— API key 在 `configFile` 引用的外部 DSH credential 文件中 provision；插件将配置原样传给公共 bootstrap，不解析或复制 Provider/credential 设置，`--dump-config` 永不包含 key。
- **权威** —— 工作区权威是调用级且精确的（#93/#94）；插件不接纳公共父路径或兄弟路径。
- **无 install script、无遥测** —— 包不带安装钩子；Observation 默认关闭，启用时是有界的、尽力而为的 OTLP 导出。
- **开发者预览** —— `0.1.x` 面向个人与小团队的可信本地使用；可能存在破坏兼容性的变更。安装风险自负。

## 更新 / 卸载

使用 DSH 的包生命周期做精确兼容更新或卸载：

```sh
dsh plugin --profile web update wsr-dsh-intake@<new-exact-version>
dsh plugin --profile web remove wsr-dsh-intake
```

WSR 不拦截这些包操作。Execution 状态根、Manifest/当前槽位、Runner 状态、`configFile` 与 `bindingFile` 都位于插件安装目录之外；兼容重装会从最后持久化边界恢复同一 Delivery 绑定。

## 已知限制

- **开发者预览** —— `0.1.x` 是 MVP candidate；可能存在破坏兼容性的变更。
- **临时 worktree** —— 在 #94 之前会话工作区作为临时 worktree；权威是调用级且精确的。
- **仅 DSH 交互面** —— 发行版以自带 `web` profile 为交互组装；自定义 profile 不是交互式 Intake 面。

## 相关

- [Execution System README](../..) —— 系统架构、交付形态、嵌入 API。
- [workflow-self-recursive](https://github.com/firestige/workflow-self-recursive) —— Execution / Evidence / Evolution 闭环。

## License

[Apache-2.0](../../LICENSE)
