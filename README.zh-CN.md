# execution-system

[English](README.md) | 中文

execution-system 是 workflow-self-recursive 的 Execution System —— 一个与宿主无关的小型执行边界：它解析并校验一个确定的 Workflow Package，将绑定信息写入不可变的 Delivery Manifest，协调当前交付并发出有界观测事实。它嵌入在每个仓库/工作区中，当 Evidence 或遥测不可用时仍会继续运行。

三个 Module 承担上述职责：

- **Delivery Binding** 解析一个确定的、本地 `READY` 的 Workflow Package（selector → 校验 → 本地 `MISSING/STAGING/READY` 存储），并构造 Manifest 内容。
- **Runtime Interaction** 拥有规范工作区排他性、当前 Delivery 槽位、Manifest 持久化、Runtime 调用、恢复与最终处理。
- **Delivery Observation** 将出站有界事实映射到单向、尽力而为的 OTLP profile，但不控制执行。

公开的 `ExecutionApplication` 与宿主无关，不安装 DSH Intake plugin 也可以直接嵌入。独立打包的 DSH Intake Adapter 是首个产品入口；通过 M01 admission 的 Workflow Action 均在 Runner 所有、与 Intake 隔离的 DSH 执行 Context 中运行。

## Developer preview

本仓库是 workflow-self-recursive 架构优先开发者预览版的一部分，适用于个人或小团队的可信本地环境。`0.1.1` 是 MVP candidate，后续可能有破坏兼容性的变更。

## Release 快速开始

1. 发布前运行 `pnpm quickstart:prepare`，一次完成两个 `0.1.1` artifact 的构建、验证和本地 E2E 配置初始化。
2. 复制 `config/defaults/execution.default.yaml`，替换全部 `__REQUIRED__` 值，并在外置 DSH credential 文件中 provision 所引用的 API key（格式为 `version: 1`、`refs: ...`）。
3. 在带交互 app 的 DSH profile 中安装（发行版以自带 `web` profile 为准）：先执行 `dsh plugin --profile web add --workspace-root <Execution-System-tarball-绝对路径>`，再以同一命令安装 `<DSH-Intake-tarball-绝对路径>`。当前 DSH preview 创建的 workspace 需要该标志。
4. 为 plugin row 填写 absolute `configFile` 与 `bindingFile`，再执行 `dsh --profile web --dump-config` 和 `dsh --profile web --help` 验证。
5. 从目标 worktree 启动 `dsh --profile web`，使用 `/wsr create implementation-workflow@0.3.0`、`/wsr list` 与 `/wsr status`。重启 Intake 时会保留 Manifest/current-slot 与 private binding state 以供恢复。

默认 Source 是配置指定的 `firestige/workflow-package` GitHub Release。`implementation-workflow@0.3.0` 与 `system-design-workflow@0.3.0` 会经过下载、校验并发布到本地 READY store；它们不会嵌进任何 Execution artifact。

Workflow Package Release 以单 Package 为范围：tag 为 `workflow-package/<name>/v<version>`，且只包含 archive、对应的 package-release descriptor 与 SHA-256 checksum。exact 与 latest selector 枚举同一个 configured Release 集合；latest 只在目标 Package 内按 SemVer 排序并排除 GitHub/SemVer prerelease，exact 则可以选择 prerelease。不可变的 initial `0.3.0` cohort descriptor 也由同一枚举算法解释。本地 READY 与 sticky-latest 在任何 Source 请求之前保持优先。使用 `pnpm release:workflow-assets -- <package-directory> <destination> <40-character-revision>` 构建单个 Release。

完整步骤见 repository-owned [本地发布前 E2E 指南](https://github.com/firestige/workflow-self-recursive/blob/main/docs/guides/dsh-execution-local-e2e.zh-CN.md)、final [DSH quickstart](https://github.com/firestige/workflow-self-recursive/blob/main/docs/guides/dsh-execution-quickstart.zh-CN.md)、[配置参考](https://github.com/firestige/workflow-self-recursive/blob/main/docs/reference/execution-configuration.zh-CN.md)与 [DSH Intake package reference](packages/dsh-intake/README.md)。Release automation 与用户安装保持为不同 surface。

Host-neutral embedding 从 package root 导入 `ExecutionApplicationFactory`、`DefaultExecutionApplicationFactory`、`ExecutionRequest`、`TaskPrompt` 与 configuration types。调用 default factory 的 `create(configFile, dependencies)` 是唯一 production bootstrap path。Exact DSH runtime 是 optional peer：package-root import/type consumer 无需安装它；执行当前 `dsh` Provider 时，embedding profile 必须提供 `@deepseek-ai/dsh@0.1.1-rc.2`。Release 包含 `config/schema/execution.config.schema.json`、versioned defaults/examples、compiled TypeScript declarations，以及 `execution-config init|copy|validate|dump-effective`。Observation 默认关闭；将 `observation.enabled` 设为 `true` 并提供 loopback OTLP base `endpoint` 即可启用 non-controlling exporter。

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
