# Context Mode for Pi Coding Agent（中文）

[English README](README.md)

> 本文档专门说明 **Pi Coding Agent 插件** 的安装、配置和功能。

## 这是什么

Context Mode 是一个 MCP server，同时也是一个给 **Pi Coding Agent 使用的插件**。它把大型命令输出、文件、网页和会话历史保存在本地，需要时再检索，避免一次性塞进模型上下文。插件提供 Pi 原生工具桥接、生命周期恢复、可选的 Bash/Read 替换、工具可见性设置和 Pi 专用显示。

Pi 插件入口是 `build/adapters/pi/host-entry.js`，由 `package.json` 的 `pi.extensions` 声明。插件会按需启动 `server.bundle.mjs`，完成 MCP 握手，并通过 Pi 自己的工具注册表注册 `ctx_*` 工具。使用这个 Pi 插件不需要再添加第二个 MCP 配置。

## 安装

**要求：**已安装 Pi Coding Agent，Node.js `>=22.5`；运行时也支持 Bun。

```bash
npm install -g context-mode
pi install npm:context-mode
```

安装后重启 Pi。源码开发使用：

```bash
pnpm install
pnpm build
```

## Pi 配置文件

Context Mode 只读取以下两个位置：

- 全局：`~/.pi/agent/context-mode/settings.json`
- 项目：`<project>/.pi/context-mode/settings.json`

**原来：** Pi 的 context-mode 配置和权限读取会复用 Claude Code 配置以及 Pi 通用的 `~/.pi/settings.json`，并保留较宽的回退路径。因此，原本给其他 host 使用的配置可能影响 Pi，或者被 Pi 意外读到。

**现在：**这些 Pi 功能只读取上面列出的两个 context-mode 专用配置文件。项目配置覆盖全局配置，并且不再回退到 Claude Code 配置或 Pi 通用配置。

**好处：**Pi 配置与其他 host 隔离，优先级明确，用户只需要管理一个项目配置路径和一个全局配置路径。

完整示例：

```json
{
  "toolReplacements": {
    "bash": { "enabled": true },
    "read": { "enabled": true, "maxLines": 300, "maxBytes": 10240 }
  },
  "tidyToolDisplay": { "enabled": true },
  "disabledBuiltinFeatures": [
    "ctx_stats",
    "ctx_doctor",
    "ctx_upgrade",
    "ctx_purge",
    "ctx_insight"
  ],
  "extensionAdapters": {
    "blackhole": { "enabled": true }
  }
}
```

所有配置段都是可选的。无效配置会安全关闭对应功能并发出警告，不会阻止 Pi 启动。修改后要重新加载插件或重启 Pi；不支持运行中切换。

## Pi 功能

### 1. Pi 原生提示词元数据

**原来：** Pi 适配器会在 `before_agent_start` 阶段组装一段静态路由提示，再通过 Pi 的 `context` hook 作为额外消息追加给模型。这段消息会告诉模型工具层级，以及什么时候选择 `ctx_execute`、`ctx_execute_file`、`ctx_batch_execute`、`ctx_search` 等工具。

**现在：** Pi 适配器在注册工具时，把稳定的工具选择说明放进 Pi 原生的 `promptSnippet` / `promptGuidelines` 元数据中。`before_agent_start` 只保留 active memory、resume data 等动态会话上下文，不再追加静态路由提示。

**好处：** 路由说明会直接附着在相关工具上，不必每轮重复发送；稳定的提示词前缀更容易被 provider 缓存；动态会话信息也不会再和静态工具说明混在同一条消息里。

### 2. Bash 和 Read 原生替换（默认关闭）

- **Bash：**启用后把 shell 工作路由到 `ctx_execute`；原生 Bash 仍保留为故障恢复通道，但从 Pi 的文字工具摘要中隐藏。只有在替换真正生效时，才移除 Pi 那条会和 `ctx_execute` 冲突的 Bash 文件探索提示。
- **Read：**保留原生 `read(path, offset?, limit?)` 形式，同时把文本限制为 `maxLines` 和 `maxBytes`；默认是 300 行和 10,240 个 UTF-8 字节。图片保持原样，续读偏移单独返回。
- 通过 Pi 当前实际工具注册表判断所有权。如果其他插件拥有 `bash` 或 `read`，就跳过替换，也不宣传更强的路由规则。
- 两个替换互相独立；明确写错一个配置只关闭对应替换，配置文件损坏或不可读时安全关闭两者。

### 3. Tidy 风格工具显示（默认关闭）

这项显示功能参照 `pi-tidy-tools` 插件（`@mobrienv/pi-tidy-tools`）的显示方式实现，但由本插件独立实现，不导入或依赖该插件。开启 `tidyToolDisplay.enabled` 后，Context Mode 的 Pi 工具会使用这一显示风格；这个开关本身不会启用 Bash 或 Read 原生替换。

如果同时开启 `toolReplacements.bash.enabled` 和／或 `toolReplacements.read.enabled`，对应工具在替换实际生效后，也会按照 `pi-tidy-tools` 的风格显示。

**两个插件一起使用时：** 如果安装了 `pi-tidy-tools`，需要将准备交给 Context Mode 替换的原生 `bash`、`read` 工具设为直通，也就是让 `pi-tidy-tools` 不替换这些工具。否则，两个插件会争用同一个工具，产生冲突。Context Mode 检测到工具已被其他插件接管时，会跳过对应替换并发出警告，不会自动组合两套替换。其他工具仍可由 `pi-tidy-tools` 负责显示。

打开后，Pi 侧的 schema 会增加仅用于显示的 `reasoning` 字段，执行前会删除它。工具调用显示为两行：分类图标、用途或目标、整行背景、耗时、结果数量和错误状态。窗口窄时保留末尾统计并用 `…` 缩短目标；展开时保留两行标题再显示结果。

`read` 和 `ctx_execute_file` 显示行数；shell 工具显示耗时；`ctx_batch_execute` 显示命令数；`ctx_search` 显示命中数；索引工具显示 section 数；其他工具显示简短的 `done`。

### 4. 工具可见性和压缩恢复

`disabledBuiltinFeatures` 是完整替换列表，不是逐项合并。它接受 11 个 `ctx_*` 工具名和 `compactRecovery`。

- 默认隐藏 `ctx_stats`、`ctx_doctor`、`ctx_upgrade`、`ctx_purge`、`ctx_insight`，因为这些工具主要供人使用，没有必要注册到 Pi 的工具列表中，避免浪费上下文空间。
- 写入空数组会恢复全部 11 个工具在 Pi 中的可见性。
- 隐藏工具只从 Pi 的注册表和提示词元数据中移除，命令行和其他 host 仍保留处理器。
- 禁用 `compactRecovery` 后，Context Mode 不再准备或发送自己的压缩恢复消息，也不再写退休标记；运行时事件采集、原生 transcript、压缩计数和显式重载恢复不受影响。
- 无效列表回退到安全默认值：隐藏五个管理工具，开启压缩恢复。
- 共享 MCP 工具目录保持完整；Pi 只过滤自己的 agent 工具注册表，其他 host 可以使用各自的可见性策略。

### 5. Pi-Blackhole 压缩恢复适配

这个 Pi 适配层支持与 `pi-blackhole` 一起运行。压缩后，`pi-blackhole` 可以注入压缩前快照，Context Mode 也会发布自己的隐藏恢复消息。适配层会协调两条消息，使它们互相补充而不是重复注入相同内容。

- 开启 `extensionAdapters.blackhole.enabled` 后，Context Mode 会从自己的压缩恢复内容中去除重复信息：`goal`、`prompt`、`file`、`error`、`skill`、`mcp`，以及类型为 `git_commit` 的 `git` 事件。
- 只会过滤 Context Mode 自己的恢复消息，不会修改 `pi-blackhole` 的消息或 Pi 原生 transcript。过滤只用于压缩恢复，不会通过此开关过滤 `resume` 恢复内容。
- 会话事件使用 Pi 原生 session ID 和按项目划分的标准 SessionDB 路径。恢复消息绑定当前分支和压缩片段，并拒绝重复回调、过期身份和其他分支。
- 普通启动和恢复会信任 Pi 原生 transcript，不再重复注入历史 SessionDB 事件。

这样，`pi-blackhole` 负责提供压缩前快照，Context Mode 只补充剩余的恢复上下文，从而减少重复 token，避免恢复信息重复。

### 6. 工具说明和校验

- 当 `git`、`rg`、`fd`、`jq`、`gh`、`yq`、`uv` 等现成命令更清楚可靠时，优先使用它们；只有 shell 不合适或逻辑复杂时才写自定义代码。
- `ctx_search` 会先拒绝缺失、空值和无效字符串查询，再判断索引是否为空。
- 对外 JSON Schema 不再宣传误导性的反斜杠查询模式，但处理器仍要求非空查询。
- 工具描述、`ctx_index`、`ctx_batch_execute`、获取网址的输入、结果统计和恢复路由说明均与实际运行行为对齐。

### 7. BUG 修复

- **桥接启动：**父 Pi 进程可能继承 `CONTEXT_MODE_BRIDGE_DEPTH`，被误认为桥接子进程，导致自身工具被禁用。修复后只给真正启动的桥接子进程设置 `CONTEXT_MODE_BRIDGE_CHILD`，并要求同时存在该标记和正数深度才停止桥接启动。
- **数据库清理：**内容数据库可能仅因 WAL 长时间没有变化就被删除，即使数据库仍在使用。现在按照主数据库的保留期限清理，不再单独依据 WAL 是否安静，从而保留仍在使用的数据库及其 WAL。

## 开发和验证

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
git diff --check
```

Pi 专用测试覆盖配置优先级和隔离、工具所有权、Read 限制、Bash 路由、提示词过滤、生命周期恢复、Tidy 显示、桥接注册和真实 host 冒烟场景。许可证是 Elastic License 2.0，详见 [LICENSE](LICENSE)。
