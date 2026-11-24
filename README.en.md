# dsh-approval-notify

A DeepSeek Harness (DSH) plugin that raises a macOS Notification Center banner at the four moments an agent stops and waits for you. [中文](README.md) | English

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

- **Banner with the tone attached.** `display notification … sound name` hands both to the system, so the tone is never truncated by a plugin-side timeout and Focus/mute rules apply exactly as they do for any other app: approval Glass, question Ping, finish Tink, error Basso.
- **Quiet when it should be.** The finish reminder is skipped while DSH is frontmost; one finish reminder per session per 5 s; error reminders are limited to one per 5 minutes, so an automation that fails every minute cannot fill the notification center; the same `callId` is announced once per 3 s.
- **Settings page** under **Settings → Plugins → 审批提醒**: seven switches (master, approval, question, finish, error, sound, skip-while-focused), four counters, the last event, and four buttons — **Send test notification**, **Self-check**, **Open system notification settings**, **Refresh**.
- **A tool for your agent**: `approval_notify` with `status`, `test`, and `diagnose`.

## Delivery and limitations

- The channel is `osascript display notification`, so macOS attributes the banner to **Script Editor** (「脚本编辑器」) — not to DSH. That is AppleScript's standard behaviour and the plugin's only channel that needs no third-party binary.
- Exit code 0 means the notification server **accepted the request**, not that you saw it. Focus modes, muting Script Editor in System Settings, or a locked screen drop it silently, so the plugin reports "submitted" instead of "seen".
- The banner cannot be clicked; AppleScript notifications have no actions.
- macOS only. On other platforms the tool reports the channel as unavailable.
- Approval reminders never appear under the `full-access` preset: it rejects approval-requiring calls outright, so no request exists to announce. Switch to read-only or workspace-write to exercise that channel.
- The plugin writes only its own status counters (`plugin-data/dsh-approval-notify/`) and its own volatile config fields. It never edits the profile patch file directly.

## Troubleshooting

1. **Settings → Plugins → 审批提醒 → Send test notification.** If a banner appears, the channel works.
2. **Self-check** also reports the frontmost app and the tone result.
3. **Open system notification settings** jumps to the macOS pane; check that **Script Editor** is allowed and that a Focus mode is not on.
4. Check `~/.dsh/profiles/<profile>/plugin-data/dsh-approval-notify/debug.log` for `notify(...)` lines, and `state.json` for the counters.

## Implementation

- `lib/notify.js` — AppleScript generation/escaping, `osascript` execution, `afplay` fallback for a rejected script.
- `lib/system.js` — frontmost app through `lsappinfo` (1 s cache), opening the notification settings pane.
- `lib/state.js` — atomic counters and last event under `plugin-data`, tolerating an older state document.
- `client.js` — the settings page, reading and writing this plugin's settings namespace through `ctx.remote.settings`.

## License

MIT