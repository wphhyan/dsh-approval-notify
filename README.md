# dsh-approval-notify

一个 DeepSeek Harness（DSH）插件：Agent 停下来等你时，弹一条 macOS 通知中心横幅。中文 | [English](README.en.md)

| 时刻 | 事件源 | 默认 |
| --- | --- | --- |
| **审批** | `approval/request` —— 工具调用需要授权；只在权限模式的审批为「询问」（只读 / 工作区写入）时出现 | 开 |
| **提问** | `user-questions/request` —— Agent 调用 `ask_user_question` | 开 |
| **完成** | `api-session/status` —— 会话跑完一轮开始等你；DSH 在前台时跳过 | 开 |
| **出错** | `api-session/error` —— 会话或回合失败 | 开 |

审批与提问是 Cordis waterfall：插件只旁听、只提醒，然后永远 `next()`。它不会替你做决定，横幅发不出去也不可能卡住工具调用。

## 安装

需要 macOS 和 DSH `>=0.2.2-rc.5 <0.3.0`。

```sh
dsh plugin --profile <profile> add github:wphhyan/dsh-approval-notify
```

然后启用该 bundle，并 **⌘Q 重启桌面端**（Host 半边的 JS 模块只在重启后换成新的一份）。桌面端的 profile 通常是 `desktop`。

插件市场里是同一个包：**插件 → 发现**，搜索 `dsh-approval-notify`，安装、启用、重启。

## 它会做什么

- **提示音跟着横幅走**：`display notification … sound name` 把横幅和声音一起交给系统，提示音不会被插件侧的超时掐断，专注模式与静音照常生效。审批 Glass、提问 Ping、完成 Tink、出错 Basso。
- **该安静时安静**：DSH 在前台时跳过「完成」提醒；同一会话 5 秒内只有一条完成提醒；「出错」5 分钟最多一条，每分钟都失败的定时任务刷不爆通知中心；同一 `callId` 3 秒内只提醒一次。
- **设置页**在 **设置 → 插件 → 审批提醒**：七个开关（总开关、审批、提问、完成、出错、提示音、前台跳过）、四类计数、最近一次事件，以及四个按钮——**发送测试通知**、**自检**、**打开系统通知设置**、**刷新**。
- **给 Agent 的工具**：`approval_notify`，支持 `status`、`test`、`diagnose`。

## 送达与限制

- 渠道是 `osascript display notification`，所以 macOS 会把横幅归到 **「脚本编辑器 / Script Editor」** 名下，而不是 DSH。这是 AppleScript 的标准行为，也是本插件唯一不需要第三方二进制的通道。
- 退出码 0 只代表通知服务**接受了请求**，不代表你看见了：专注模式、在系统设置里把「脚本编辑器」静音、锁屏，都会静默丢弃。插件如实写"已提交"，不假装"已送达"。
- 横幅不能点击跳转：AppleScript 通知没有动作。
- 仅 macOS。其他平台上工具会报告渠道不可用。
- 在「完全访问」权限模式下永远不会触发审批提醒：它直接拒绝需要审批的操作，根本不存在要广播的请求。要验证这条通道，切到「只读」或「工作区写入」。
- 插件只写自己的计数（`plugin-data/dsh-approval-notify/`）和自己的 volatile 配置字段，不直接改 profile 的 patch 文件。

## 排错

1. **设置 → 插件 → 审批提醒 → 发送测试通知**：有横幅说明通道可用。
2. **自检**会额外报告前台应用与提示音结果。
3. **打开系统通知设置**跳到 macOS 面板，确认「脚本编辑器」未被静音、没开专注模式。
4. 看 `~/.dsh/profiles/<profile>/plugin-data/dsh-approval-notify/debug.log` 里的 `notify(...)` 行，以及 `state.json` 的计数。

## 实现

- `lib/notify.js` —— AppleScript 生成与转义、`osascript` 执行、脚本被拒时用 `afplay` 兜底。
- `lib/system.js` —— 用 `lsappinfo` 判断前台应用（1 秒缓存）、打开系统通知面板。
- `lib/state.js` —— `plugin-data` 下的原子计数与最近事件，兼容旧版状态文档。
- `client.js` —— 设置页，通过 `ctx.remote.settings` 读写本插件的设置命名空间。

## 许可

MIT