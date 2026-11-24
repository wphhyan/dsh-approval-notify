# @local/dsh-approval-notify

Agent 停下来等你的四个时刻，弹一条 macOS 通知中心横幅：

| 事件 | 触发条件 | 默认 |
| --- | --- | --- |
| **审批** `approval/request` | 工具调用需要授权；仅当权限模式的审批为「询问」（只读 / 工作区写入）时才会出现 | 开 |
| **提问** `user-questions/request` | Agent 调用 `ask_user_question` | 开 |
| **完成** `api-session/status` | 会话从 running 变为 idle，开始等你；DSH 在前台时默认跳过 | 开 |
| **出错** `api-session/error` | 会话出错、回合异常结束 | 开 |

审批与提问是 Cordis waterfall：插件只旁听并**永远 `next()`**，不替你做决定，也不影响工具调用。

## 为什么以前收不到

1. **审批通知天然很少**：`danger-full-access`（完全访问）会直接拒绝需要审批的操作，审批请求根本不会发生。要看到审批提醒，把权限模式改成「只读」或「工作区写入」。
2. **没有"完成"事件源**：旧版只监听审批与提问，正常干活时一次都不触发，状态行永远"还没有触发过"。1.2 增加完成与出错两个通道。
3. **提示音被掐断**：旧版用 `afplay Glass.aiff`（2.4 秒）配 2.5 秒超时，几乎每次都在播到一半被 `SIGKILL`，状态里反而写"超时"。1.2 把提示音写进通知本身（`sound name`），由系统随横幅播放，审批 Glass、提问 Ping、完成 Tink、出错 Basso。

## 送达与限制

- 渠道是 `osascript display notification`，macOS 会把它归到 **「脚本编辑器 / Script Editor」** 名下，横幅图标与名称都是它，不是 DSH。这是 AppleScript 的标准行为，也是本插件唯一不依赖第三方二进制的通道。
- `osascript` 退出码 0 只代表**请求被通知中心接受**，不代表你一定看见了：专注模式、系统设置里把「脚本编辑器」静音、或屏幕已进入勿扰，都会静默丢弃。插件把这一层如实写成"已提交"，不假装"已送达"。
- 不清理、不合并、不排队：每个事件一条横幅；同一 `callId` 3 秒内只提醒一次，同一会话的"完成"提醒 5 秒内只发一次。
- 平台：仅 macOS；其他平台工具会报告渠道不可用。
- 横幅不能点击跳转。AppleScript 通知没有动作，点它只会打开通知中心。

## 设置页

**设置 → 插件 → 审批提醒**：状态行、七个开关（总开关 / 审批 / 提问 / 完成 / 出错 / 提示音 / 前台跳过）、以及四个按钮：

- **发送测试通知**：走和真实事件完全相同的通道；
- **自检**：发测试通知并报告前台应用、提示音结果与排查提示；
- **打开系统通知设置**：跳到 macOS 通知面板，去检查「脚本编辑器」的权限；
- **刷新**。

开关是 `volatile` 字段，改动即时生效，不需要重启插件。

## 工具

`approval_notify`：

- `status`：开关、四类计数、最近一次事件、渠道与前台应用；
- `test`：发一条测试通知；
- `diagnose`：发测试通知 + 前台应用/提示音/排查建议。

## 诊断

- 设置页状态行与详情行：渠道、前台、横幅结果、跳过原因、错误；
- `~/.dsh/profiles/<profile>/plugin-data/dsh-approval-notify/state.json`：累计计数与最近一次事件；
- `.../dsh-approval-notify/debug.log`：激活、每次通知、配置写入与监听失败的追加日志（上限 64 KB）。

## 实现要点

- `lib/notify.js`：AppleScript 生成与转义、`osascript` 执行、失败时用 `afplay` 兜底播 Glass；
- `lib/system.js`：`lsappinfo` 判断前台应用（1 秒缓存）、打开系统通知面板；
- `lib/state.js`：计数与最近事件的原子写入，`plugin-data` 定位兼容 `DSH_PROFILE_DIR` 与工作目录；
- 配置写回走 `configEditor` + HMR `exit` 事务，不直接改 profile 的 patch 文件。