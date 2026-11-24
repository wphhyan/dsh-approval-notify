# dsh-approval-notify

[简体中文](README.md) | **English**

Raises a macOS Notification Center banner at the four moments an agent stops and waits for you: a tool approval, an ask_user_question prompt, a finished turn, and a session error — one switch each, and clicking the banner brings DSH back to the front.

![platform](https://img.shields.io/badge/platform-macOS-000000)
![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.5-4B6BFB)
![license](https://img.shields.io/badge/license-MIT-green)

| Event | Source | Default |
| --- | --- | --- |
| **Approval** | `approval/request` — a tool call needs permission; only exists while the permission preset asks (read-only / workspace-write) | on |
| **Question** | `user-questions/request` — the agent calls `ask_user_question` | on |
| **Finish** | `api-session/status` — a session stops running and waits for you; skipped while DSH is frontmost | on |
| **Error** | `api-session/error` — a session or turn failed | on |

The approval and question events are Cordis waterfalls: the plugin listens, announces, and always delegates with `next()`. It never answers, and a missing banner can never block a tool call.

## Install

Requires macOS and DSH `>=0.2.2-rc.5 <0.3.0`.

```sh
dsh plugin --profile <profile> add github:wphhyan/dsh-approval-notify
```

Then enable the bundle, and restart the desktop app (⌘Q) so the Host half loads its module generation. On desktop the profile is usually `desktop`; find it in **Settings → Plugins**.

The market install is the same package: **Plugins → Discover**, search for `dsh-approval-notify`, install, enable, restart.

## What you get

- **Clickable banners.** A ~600 KB `DSH Notify` helper app ships with the plugin (source in `helper/`, reproducible build script) and posts the banner from its own identity: clicking it activates the DSH desktop app, or opens the page when only `dsh web` runs. The notification permission is requested only by the settings page's request button.
- **Banner with the tone attached.** `display notification … sound name` / `--sound` hands both to the system, so the tone is never truncated by a plugin-side timeout and Focus/mute rules apply exactly as they do for any other app: approval Glass, question Ping, finish Tink, error Basso.
- **Quiet when it should be.** The finish reminder is skipped while DSH is frontmost; one finish reminder per session per 5 s; error reminders are limited to one per 5 minutes, so an automation that fails every minute cannot fill the notification center; the same `callId` is announced once per 3 s.
- **Settings page** under **Settings → Plugins → 审批提醒**: nine switches (master, approval, question, finish, error, sound, skip-while-focused, clickable, also notify scheduled runs), four counters, the last event, and five buttons — **Request notification permission**, **Send test notification**, **Self-check**, **Open system notification settings**, **Refresh**.
- **A tool for your agent**: `approval_notify` with `status`, `test`, and `diagnose`.

## Delivery and limitations

- With **clickable** on, the helper posts the banner and macOS shows it as **DSH Notify**; clicking it brings DSH to the front. The permission is requested only by the **Request notification permission** button in the settings page — a notification itself never opens an authorization dialog. Without permission, or after a denial, delivery falls back to the compatible channel automatically (banners still arrive, shown as Script Editor) until you allow DSH Notify in System Settings → Notifications.
- **Scheduled runs stay quiet by default**: sessions created by `dsh-automation-session-*` (the scheduling plugin) do not raise finish or error reminders, so a broken one-minute task cannot fill the notification center; turn on **Also notify scheduled runs** when you want them.
- With **clickable** off (or the helper missing), delivery falls back to `osascript display notification`: no permission prompt, but macOS attributes the banner to **Script Editor** (「脚本编辑器」) and it cannot be clicked. That channel stays as the safety net.
- Exit code 0 means the notification server **accepted the request**, not that you saw it. Focus modes, muting Script Editor in System Settings, or a locked screen drop it silently, so the plugin reports "submitted" instead of "seen".
- macOS only. On other platforms the tool reports the channel as unavailable.
- Approval reminders never appear under the `full-access` preset: it rejects approval-requiring calls outright, so no request exists to announce. Switch to read-only or workspace-write to exercise that channel.
- The plugin writes only its own status counters (`plugin-data/dsh-approval-notify/`) and its own volatile config fields. It never edits the profile patch file directly.

## Troubleshooting

1. **Settings → Plugins → 审批提醒 → Request notification permission** (once; it shows the single system dialog), then **Send test notification**. If a banner appears, the channel works.
2. **Self-check** also reports the frontmost app and the tone result.
3. **Open system notification settings** jumps to the macOS pane; check that **DSH Notify** (or **Script Editor** for the fallback channel) is allowed and that a Focus mode is not on.
4. Check `~/.dsh/profiles/<profile>/plugin-data/dsh-approval-notify/debug.log` for `notify(...)` lines, and `state.json` for the counters.

## Implementation

- `lib/notify.js` — starts `helper/DSHNotify.app` first (clickable, handles the click), falls back to AppleScript + `osascript`, and to `afplay` when the scripted request is rejected.
- `helper/dsh-notify.m` — about 200 lines of Objective-C: deliver through `UNUserNotificationCenter`, keep a run loop alive for the click, then activate `com.deepseek.dsh` or open the web GUI URL; `helper/build.sh` compiles universal (arm64 + x86_64) and ad-hoc signs it.
- `lib/system.js` — frontmost app through `lsappinfo` (1 s cache), opening the notification settings pane.
- `lib/state.js` — atomic counters and last event under `plugin-data`, tolerating an older state document.
- `client.js` — the settings page, reading and writing this plugin's settings namespace through `ctx.remote.settings`.

## License

MIT