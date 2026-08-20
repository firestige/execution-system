# execution-system

[English](README.md) | 中文

execution-system 是 workflow-self-recursive 的 Execution System —— 一个与宿主无关的小型执行边界：它解析并校验一个确定的 Workflow Package，将绑定信息写入不可变的 Delivery Manifest，协调当前交付并发出有界观测事实。它嵌入在每个仓库/工作区中，当 Evidence 或遥测不可用时仍会继续运行。

三个 Module 承担上述职责：

- **Delivery Binding** 解析一个确定的、本地 `READY` 的 Workflow Package（selector → 校验 → 本地 `MISSING/STAGING/READY` 存储），并构造 Manifest 内容。
- **Runtime Interaction** 拥有规范工作区排他性、当前 Delivery 槽位、Manifest 持久化、Runtime 调用、恢复与最终处理。
- **Delivery Observation** 将出站有界事实映射到单向、尽力而为的 OTLP profile，但不控制执行。

Runtime 是位于 Core 边界之后的可替换适配器：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是首个，后续计划提供第一方 LangGraph 适配器。

## Developer preview

本仓库是 workflow-self-recursive 架构优先开发者预览版的一部分，适用于个人或小团队的可信本地环境。当前发布 Execution 设计与组件边界，尚未提供可供最终用户运行的发行版。**后续会有破坏兼容性的变更。**

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
