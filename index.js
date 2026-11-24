/**
 * Approval notifications — Host half.
 *
 * Four moments stop an agent and wait for the human: `approval/request` (a tool
 * action needs permission), `user-questions/request` (`ask_user_question`), a
 * Session that stops running (`api-session/status`), and a Session that fails
 * (`api-session/error`). The first two are Cordis waterfalls whose composed
 * answerer is the browser UI, so this plugin joins as a listener that announces
 * the pending decision and always delegates with `next()` — it never answers.
 *
 * Delivery is a Notification Center banner with the alert tone attached to the
 * request, so the system owns the audio and the plugin never cuts it off.
 * The settings page under Settings → Plugins owns the switches; this half owns
 * the counters, the last event, and the diagnostics.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { TONES, deliver, helperAuthorization, helperAvailable, isSupported, requestAuthorization, truncate } from './lib/notify.js'
import { readState, trace, writeState } from './lib/state.js'
import { fmt, texts } from './lib/messages.js'
import { DSH_BUNDLE_ID, dshIsFrontmost, frontmost, idleSeconds, openNotificationSettings } from './lib/system.js'

export const name = 'approval-notify'

export const inject = ['tools']

/**
 * Load the schema factory.
 *
 * A linked development bundle resolves its imports from its own directory, which
 * need not sit under the profile's `node_modules`; fall back to the schema copy
 * that ships with the running dsh installation.
 * @returns {Promise<object>} schemastery factory.
 */
async function loadSchema() {
  try {
    return (await import('@deepseek-ai/schemastery')).default
  } catch {}
  const require = createRequire(import.meta.url)
  const anchors = [
    process.env.DSH_INSTALL_DIR,
    process.env.DSH_HOME,
    path.dirname(process.execPath),
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ].filter(value => typeof value === 'string' && value !== '')
  let lastError
  for (const anchor of anchors) {
    try {
      const resolved = require.resolve('@deepseek-ai/schemastery', { paths: [anchor] })
      const loaded = require(resolved)
      return loaded.default ?? loaded
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`@deepseek-ai/schemastery is not resolvable; set DSH_INSTALL_DIR (${lastError?.message ?? 'unknown error'})`)
}

const z = await loadSchema()

export const Config = z.object({
  enabled: z.boolean().default(true).volatile()
    .description('总开关：关闭后审批、提问、完成、出错都不再发送任何通知。'),
  approvals: z.boolean().default(true).volatile()
    .description('工具调用需要你授权时提醒。只在权限模式的审批为「询问」（只读 / 工作区写入）时才会发生。'),
  questions: z.boolean().default(true).volatile()
    .description('Agent 通过 ask_user_question 向你提问时提醒。'),
  finishes: z.boolean().default(true).volatile()
    .description('一个会话跑完一轮、开始等你时提醒。默认开启；DSH 在前台时会跳过。'),
  errors: z.boolean().default(true).volatile()
    .description('会话出错（模型请求失败、回合异常结束）时提醒。'),
  sound: z.boolean().default(true).volatile()
    .description('通知随横幅播放提示音：审批 Glass、提问 Ping、完成 Tink、出错 Basso。'),
  skipWhenFocused: z.boolean().default(true).volatile()
    .description('DSH 在前台时不发「完成」提醒；审批与提问不受此开关影响。'),
  idleOnly: z.boolean().default(false).volatile()
    .description('只在用户离开键盘时发「完成」提醒：空闲满 60 秒才提醒，替代「DSH 在前台」判断（浏览器打开 GUI 时更准确）。'),
  clickable: z.boolean().default(true).volatile()
    .description('横幅可点击：点击后把 DSH 切到前台，横幅显示为「DSH Notify」。需要一次通知授权，用「请求通知授权」按钮显式发起，通知本身永远不会弹授权框；未授权时自动走 osascript 兼容通道。'),
  scheduled: z.boolean().default(false).volatile()
    .description('定时任务产生的会话（@michengai/dsh-automation 的 dsh-automation-session-*）也发完成 / 出错提醒。默认关，避免每分钟跑一次的定时任务刷屏。'),
  authorizeNow: z.boolean().default(false).volatile()
    .description('「请求通知授权」：打开后向 macOS 请求一次 DSH Notify 的通知权限，完成后自动关闭。'),
  testNow: z.boolean().default(false).volatile()
    .description('「发送测试通知」：打开后立即发一条测试通知，完成或失败后自动关闭。'),
  diagnoseNow: z.boolean().default(false).volatile()
    .description('「自检」：打开后发一条测试通知并报告通道、前台应用与兜底音源，完成后自动关闭。'),
  openSettingsNow: z.boolean().default(false).volatile()
    .description('「打开系统通知设置」：打开后跳到 macOS 通知设置面板，完成后自动关闭。'),
  clientLocale: z.string().default('zh').volatile()
    .description('由设置页写入的界面语言（zh / en）；Host 用它选择通知与状态文案。'),
  status: z.string().default('').volatile()
    .description('只读状态：渠道、计数与最近一次事件，由插件写回，无需编辑。'),
  details: z.string().default('').volatile()
    .description('只读：渠道、前台应用、声音来源与排查提示。'),
})

/** How long one repeated call id is treated as already announced (3 s). */
const DEDUPE_MS = 3000

/** A Session that flaps running→idle→running keeps one finish reminder per interval. */
const FINISH_QUIET_MS = 5000

/** Sessions often finish together; one banner beats a burst of them. */
const FINISH_COALESCE_MS = 4000

/** Seconds of keyboard/mouse inactivity that count as "away" in idle mode. */
const IDLE_SECONDS = 60

/** One error banner per Session per window. */
const ERROR_SESSION_QUIET_MS = 5 * 60 * 1000

/** A global cap keeps unrelated failures from flooding the notification center. */
const ERROR_GLOBAL_WINDOW_MS = 10 * 60 * 1000
const ERROR_GLOBAL_MAX = 3

/** Session ids created by the scheduling plugin; they are runs, not human waits. */
const SCHEDULED_PREFIX = 'dsh-automation-session-'

/**
 * Whether a Session was started by a scheduled task rather than by the user.
 * @param {string} sessionId - Session id.
 * @returns {boolean} true for automation runs.
 */
function isScheduledRun(sessionId) {
  return sessionId.startsWith(SCHEDULED_PREFIX)
}

/** Which counter a delivered notification advances. */
const COUNTERS = {
  审批: 'approvals',
  提问: 'questions',
  完成: 'finishes',
  出错: 'errors',
}

/**
 * Human-readable duration for a Session's running window.
 * @param {number} milliseconds - elapsed time.
 * @returns {string} compact duration such as `3 分 12 秒`.
 */
function duration(milliseconds, t) {
  const total = Math.max(0, Math.round(milliseconds / 1000))
  if (total < 60) return fmt(t.durationSeconds, { value: total })
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) {
    return seconds === 0
      ? fmt(t.durationMinutes, { value: minutes })
      : fmt(t.durationMinutesSeconds, { minutes, seconds })
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? fmt(t.durationHours, { value: hours })
    : fmt(t.durationHoursMinutes, { hours, minutes: rest })
}

/**
 * Local wall-clock label for the status line.
 * @param {string} iso - ISO timestamp.
 * @returns {string} `HH:MM:SS`, or an empty string for an empty timestamp.
 */
function clock(iso) {
  if (iso === '') return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * @param {object} ctx - plugin context.
 * @param {object} config - live plugin configuration (volatile fields expose `get()`).
 */
export function apply(ctx, config) {
  /** @type {Map<string, number>} recent notification keys. */
  const recent = new Map()
  /** @type {Map<string, string>} Session id → short label, from the list summaries. */
  const labels = new Map()
  /** @type {Map<string, number>} Session id → when it started running. */
  const runningSince = new Map()
  /** @type {Map<string, number>} Session id → when its last error was seen. */
  const lastErrorAt = new Map()
  /** Error banners inside the global window, so failures cannot spam the center. */
  const errorNoticeTimes = []
  /** Counters are read from disk once per activation and kept in memory. */
  let state = readState()
  let lastBanner = ''
  let lastError = ''
  let lastSkip = ''
  let lastChannel = ''
  let lastHelper = ''
  let busy = false
  let pendingRefresh = ''
  let lastPublishAt = 0
  /** @type {{ id: string, label: string, startedAt: number, endedAt: number }[]} */
  let finishBatch = []
  let finishTimer
  let timer

  /** @param {string} field @returns {unknown} live value of an ordinary or volatile field. */
  const read = field => {
    const value = config?.[field]
    return typeof value?.get === 'function' ? value.get() : value
  }

  /** The HMR service serializes module and configuration replacement. */
  const hmr = () => {
    try {
      return ctx.get('hmr')
    } catch {
      return undefined
    }
  }

  /**
   * Run configuration work outside an inherited HMR transaction.
   *
   * Plugin activation and module reload run inside the HMR transaction, and that
   * async context stays attached to anything scheduled from it. A configuration
   * write started there is refused as nested, so leave the store first.
   * @param {() => Promise<unknown>} operation - work to run.
   * @returns {Promise<unknown>} operation result.
   */
  const outsideHmr = operation => {
    const storage = hmr()?.executing
    if (storage !== undefined && typeof storage.exit === 'function') return storage.exit(operation)
    return operation()
  }

  /**
   * Persist this plugin's own volatile fields without touching the user's patch file.
   * @param {object} patch - fields to merge into this entry's config.
   * @returns {Promise<boolean>} whether the write was accepted.
   */
  const writeConfig = async patch => {
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (entry === undefined || editor === undefined) return false
    // The profile-wide writer lock is held while pnpm touches the profile
    // (plugin install, lockfile rewrite); a single attempt loses that race and
    // would leave the settings page showing a stale status. Retry with backoff.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await outsideHmr(() => editor.edit(entry, current => ({ ...current, ...patch })))
        trace(`config write ok: ${JSON.stringify(patch)}`)
        return true
      } catch (error) {
        trace(`config write attempt ${String(attempt + 1)} failed: ${error?.message ?? String(error)}`)
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1) ** 2))
      }
    }
    return false
  }

  /** Active notification sources, for the status line. */
  const channels = () => {
    const t = text()
    const list = []
    if (read('approvals') === true) list.push(t.kindApproval)
    if (read('questions') === true) list.push(t.kindQuestion)
    if (read('finishes') === true) list.push(t.kindFinish)
    if (read('errors') === true) list.push(t.kindError)
    return list
  }

  /** Whether the clickable helper can actually deliver right now. */
  const clickReady = () => read('clickable') === true && helperAvailable()
    && helperAuthorization() === 'authorized'

  /** Keep a per-session map bounded on long uptimes. */
  const cap = map => {
    while (map.size > 400) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /** Active UI language reported by the client half. */
  const language = () => (read('clientLocale') === 'en' ? 'en' : 'zh')

  /** Message table for the active language. */
  const text = () => texts(language())

  /** Display label for a stored event kind. */
  const KIND_KEYS = {
    审批: 'kindApproval',
    提问: 'kindQuestion',
    完成: 'kindFinish',
    出错: 'kindError',
    自检: 'kindSelfCheck',
  }
  const kindLabel = kind => text()[KIND_KEYS[kind] ?? 'kindApproval']

  /** Last event sentence, translated. */
  const lastEvent = () => state.lastLabel === ''
    ? ''
    : `${clock(state.lastAt)} ${kindLabel(String(state.lastKind))} ${state.lastLabel}`

  /** One-line status shared by the settings page and the tool. */
  const statusLine = () => {
    const t = text()
    const total = Number(state.approvals ?? 0) + Number(state.questions ?? 0)
      + Number(state.finishes ?? 0) + Number(state.errors ?? 0)
    if (!isSupported()) return t.statusUnsupported
    if (read('enabled') !== true) return fmt(t.statusDisabled, { total })
    const active = channels()
    if (active.length === 0) return t.statusNoChannels
    const last = lastEvent() === '' ? t.statusNever : lastEvent()
    return fmt(t.statusActive, {
      channels: active.join(' + '),
      approvals: Number(state.approvals ?? 0),
      questions: Number(state.questions ?? 0),
      finishes: Number(state.finishes ?? 0),
      errors: Number(state.errors ?? 0),
      last,
      click: clickReady() ? t.clickOn : t.clickOff,
    })
  }

  /** Multi-line diagnostics for the settings page. */
  const detailLine = () => {
    const t = text()
    const parts = []
    const clickable = read('clickable') === true
    if (clickable && helperAvailable()) {
      const auth = helperAuthorization()
      const authorization = auth === 'authorized' ? t.authAllowed
        : auth === 'denied' ? t.authDenied
          : auth === 'notDetermined' ? t.authNotDetermined
            : t.authUnknown
      parts.push(fmt(t.detailHelper, { auth: authorization }))
    } else if (clickable) {
      parts.push(t.detailHelperMissing)
    } else {
      parts.push(t.detailOsascript)
    }
    if (lastHelper === 'unauthorized') parts.push(t.detailLastUnauthorized)
    else if (lastHelper === 'denied') parts.push(t.detailLastDenied)
    if (read('scheduled') !== true) parts.push(t.detailScheduledOff)
    parts.push(read('sound') === true ? t.detailSoundOn : t.detailSoundOff)
    if (lastChannel !== '') {
      parts.push(fmt(t.detailChannelUsed, { channel: lastChannel === 'helper' ? 'DSH Notify' : 'osascript' }))
    }
    const app = frontmost()
    const appName = app.name === '' ? (app.bundleId === '' ? t.authUnknown : app.bundleId) : app.name
    if (read('idleOnly') === true) {
      parts.push(fmt(t.detailFrontmostIdle, { app: appName, idle: Math.round(idleSeconds()) }))
    } else if (read('skipWhenFocused') === true) {
      parts.push(fmt(t.detailFrontmostFocus, { app: appName }))
    } else {
      parts.push(fmt(t.detailFrontmostPlain, { app: appName }))
    }
    if (lastBanner !== '') parts.push(fmt(t.detailBanner, { banner: lastBanner }))
    if (lastSkip !== '') parts.push(fmt(t.detailSkip, { skip: lastSkip }))
    if (lastError !== '') parts.push(fmt(t.detailError, { error: lastError }))
    parts.push(t.detailApprovalHint)
    return parts.join(' · ').slice(0, 400)
  }

  /**
   * Publish the current status into the plugin's own config fields.
   *
   * Event-driven publishes are throttled so a busy Session cannot rewrite the
   * profile patch every few seconds; explicit actions (a switch, a test, a
   * self-check) pass `force` and land immediately.
   * @param {string} [message] - extra sentence appended to the status line.
   * @param {{ force?: boolean }} [options] - bypass the throttle.
   * @returns {Promise<void>} completion.
   */
  const publish = async (message, options = {}) => {
    const status = `${statusLine()}${message === undefined || message === '' ? '' : ` ${message}`}`
    const details = detailLine()
    if (read('status') === status && read('details') === details) return
    if (options.force !== true && Date.now() - lastPublishAt < 15000) return
    const written = await writeConfig({ status, details })
    if (written) lastPublishAt = Date.now()
  }

  /**
   * The advertised web GUI URL, used as the click target when only `dsh web`
   * runs (no desktop app to activate).
   * @returns {string} authenticated URL, or an empty string.
   */
  const guiUrl = () => {
    try {
      const url = ctx.get('webApp')?.getAdvertisedUrl?.()
      return typeof url === 'string' ? url : ''
    } catch {
      return ''
    }
  }

  /**
   * Show one notification and record it.
   * @param {'审批'|'提问'|'完成'|'出错'|'自检'} kind - event kind.
   * @param {{ title: string, subtitle?: string, body: string }} message - content.
   * @param {string} [tone] - alert tone name.
   * @returns {Promise<{ ok: boolean, banner: string, sound: string, error?: string }>} outcome.
   */
  const send = async (kind, message, tone, count = 1) => {
    if (!isSupported()) {
      const unsupported = text().statusUnsupported
      return { ok: false, banner: unsupported, sound: 'off', error: unsupported }
    }
    const outcome = await deliver(message, {
      sound: read('sound') === true,
      tone,
      click: read('clickable') === true,
      bundleId: DSH_BUNDLE_ID,
      focusUrl: 'dsh://open',
      url: guiUrl(),
    })
    lastChannel = outcome.channel
    lastHelper = outcome.helper ?? ''
    lastBanner = outcome.banner === 'submitted'
      ? fmt(text().submittedAt, { time: clock(new Date().toISOString()) })
      : outcome.banner
    lastError = outcome.ok ? '' : String(outcome.banner)
    trace(`notify(${kind}) banner=${outcome.banner} sound=${outcome.sound} title=${message.title}`)
    const counter = COUNTERS[kind]
    // A self-check exercises the channel; it must not overwrite the last real
    // event or move a counter that stands for "the agent waited for you". A
    // delivery still waiting for the notification server does not count either.
    if (outcome.ok && outcome.confirmed !== false && counter !== undefined) {
      state = writeState({
        lastKind: kind,
        lastAt: new Date().toISOString(),
        lastLabel: message.subtitle ?? truncate(message.body, 24),
        lastBanner,
        [counter]: Number(state[counter] ?? 0) + count,
      })
      void publish().catch(error => trace(`publish after notify failed: ${error?.stack ?? String(error)}`))
    }
    return outcome.ok
      ? { ok: true, banner: outcome.banner, sound: outcome.sound, channel: outcome.channel, helper: outcome.helper, confirmed: outcome.confirmed }
      : { ok: false, banner: outcome.banner, sound: outcome.sound, channel: outcome.channel, helper: outcome.helper, confirmed: outcome.confirmed, error: lastError }
  }

  /**
   * Whether a recently announced key should be skipped.
   * @param {string} key - dedupe key.
   * @param {number} [window] - suppression window.
   * @returns {boolean} true when this key was announced recently.
   */
  const suppressed = (key, window = DEDUPE_MS) => {
    const seen = recent.get(key)
    if (seen !== undefined && Date.now() - seen < window) return true
    recent.set(key, Date.now())
    if (recent.size > 96) {
      const oldest = [...recent.entries()].sort((left, right) => left[1] - right[1])[0]
      if (oldest !== undefined) recent.delete(oldest[0])
    }
    return false
  }

  /**
   * Announce one pending approval and delegate the decision.
   * @param {object} request - `ApprovalRequestEvent`.
   * @returns {Promise<void>} completion.
   */
  const announceApproval = async request => {
    if (read('enabled') !== true || read('approvals') !== true) return
    if (suppressed(`approval:${String(request?.callId ?? request?.toolName ?? 'unknown')}`)) return
    const t = text()
    const tool = typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : t.genericTool
    const display = request?.displayReason
    const reason = typeof display?.zh === 'string' && display.zh !== ''
      ? display.zh
      : typeof display?.en === 'string' && display.en !== ''
        ? display.en
        : typeof request?.reason === 'string' ? request.reason : ''
    const body = reason === '' ? fmt(t.notifyApprovalBody, { tool }) : truncate(reason)
    await send('审批', { title: t.notifyApprovalTitle, subtitle: truncate(tool, 60), body }, TONES.approval)
  }

  /**
   * Announce one pending user question and delegate the answer.
   * @param {object} request - `AskUserQuestionRequestEvent`.
   * @returns {Promise<void>} completion.
   */
  const announceQuestion = async request => {
    if (read('enabled') !== true || read('questions') !== true) return
    const items = Array.isArray(request?.questions) ? request.questions : []
    if (items.length === 0) return
    if (suppressed(`question:${String(request?.wait?.callId ?? items[0]?.id ?? 'unknown')}`)) return
    const header = typeof items[0]?.header === 'string' && items[0].header !== '' ? items[0].header : undefined
    const body = truncate(items.map(item => (typeof item?.question === 'string' ? item.question : '')).filter(Boolean).join(' / '))
    if (body === '') return
    const t = text()
    await send('提问', { title: t.notifyQuestionTitle, subtitle: header === undefined ? undefined : truncate(header, 60), body }, TONES.question)
  }

  /**
   * Remember the readable name of a Session so a finish reminder can name it.
   * @param {object} summary - `SessionSummary`.
   * @returns {void}
   */
  const rememberSession = summary => {
    const id = String(summary?.sessionId ?? '')
    if (id === '') return
    if (summary?.origin === 'subagent' || summary?.parentSessionId !== undefined) {
      labels.delete(id)
      return
    }
    const directory = typeof summary?.cwd === 'string' && summary.cwd !== ''
      ? path.basename(summary.cwd)
      : ''
    labels.set(id, directory === '' ? id.slice(0, 12) : directory)
    cap(labels)
  }

  /**
   * Send the queued finish reminders as one banner.
   *
   * A batch is flushed after a short window so several Sessions that finish at
   * the same time produce one notification instead of a burst. Focus is checked
   * at flush time, not at arrival time.
   * @returns {void}
   */
  const flushFinishes = () => {
    if (finishBatch.length === 0) return
    const items = finishBatch
    finishBatch = []
    if (read('enabled') !== true || read('finishes') !== true) return
    const t = text()
    if (read('idleOnly') === true) {
      const idle = idleSeconds()
      if (idle < IDLE_SECONDS) {
        lastSkip = fmt(t.skipIdle, { idle: Math.round(idle) })
        return
      }
    } else if (read('skipWhenFocused') === true && dshIsFrontmost()) {
      lastSkip = fmt(t.skipFocused, { time: clock(new Date().toISOString()) })
      return
    }
    lastSkip = ''
    if (items.length === 1) {
      const item = items[0]
      void send('完成', {
        title: t.notifyFinishTitle,
        subtitle: truncate(item.label, 60),
        body: fmt(t.finishBody, {
          label: item.label,
          duration: duration(item.endedAt - item.startedAt, t),
        }),
      }, TONES.finish).catch(error => trace(`finish notify failed: ${error?.stack ?? String(error)}`))
      return
    }
    const labels = [...new Set(items.map(item => item.label))]
    const separator = language() === 'en' ? ', ' : '、'
    const body = labels.length > 3
      ? fmt(t.finishBatchBodyMore, { labels: labels.slice(0, 3).join(separator), count: items.length })
      : fmt(t.finishBatchBody, { labels: labels.join(separator) })
    void send('完成', {
      title: t.notifyFinishTitle,
      subtitle: fmt(t.finishBatchSubtitle, { count: items.length }),
      body: truncate(body),
    }, TONES.finish, items.length).catch(error => trace(`finish notify failed: ${error?.stack ?? String(error)}`))
  }

  /**
   * Announce that a Session stopped working and now waits for the user.
   * @param {string} sessionId - Session id.
   * @param {boolean} running - new running state.
   * @returns {void}
   */
  const onSessionStatus = (sessionId, running) => {
    const id = String(sessionId ?? '')
    if (id === '') return
    if (isScheduledRun(id) && read('scheduled') !== true) return
    if (running === true) {
      runningSince.set(id, Date.now())
      cap(runningSince)
      return
    }
    const started = runningSince.get(id)
    runningSince.delete(id)
    if (started === undefined) return
    if (read('enabled') !== true || read('finishes') !== true) return
    if (suppressed(`finish:${id}`, FINISH_QUIET_MS)) return
    if (Date.now() - (lastErrorAt.get(id) ?? 0) < 10000) {
      lastSkip = text().skipAfterError
      return
    }
    const label = labels.get(id) ?? id.slice(0, 12)
    finishBatch.push({ id, label, startedAt: started, endedAt: Date.now() })
    if (finishBatch.length > 20) {
      flushFinishes()
      return
    }
    if (finishTimer === undefined) {
      finishTimer = setTimeout(() => {
        finishTimer = undefined
        flushFinishes()
      }, FINISH_COALESCE_MS)
    }
  }

  /**
   * Announce a Session failure.
   * @param {string} sessionId - Session id.
   * @param {string} message - failure text.
   * @returns {void}
   */
  const onSessionError = (sessionId, message) => {
    if (read('enabled') !== true || read('errors') !== true) return
    const id = String(sessionId ?? '')
    if (id === '') return
    if (isScheduledRun(id) && read('scheduled') !== true) return
    const seenAt = lastErrorAt.get(id) ?? 0
    lastErrorAt.set(id, Date.now())
    cap(lastErrorAt)
    if (suppressed(`error:${id}`)) return
    const now = Date.now()
    if (now - seenAt < ERROR_SESSION_QUIET_MS) {
      lastSkip = text().skipSessionError
      return
    }
    const recent = errorNoticeTimes.filter(at => now - at < ERROR_GLOBAL_WINDOW_MS)
    errorNoticeTimes.length = 0
    errorNoticeTimes.push(...recent)
    if (errorNoticeTimes.length >= ERROR_GLOBAL_MAX) {
      lastSkip = fmt(text().skipErrorCap, { max: ERROR_GLOBAL_MAX })
      return
    }
    errorNoticeTimes.push(now)
    const label = labels.get(id) ?? id.slice(0, 12)
    const t = text()
    const body = truncate(typeof message === 'string' && message !== '' ? message : t.errorFallbackBody)
    void send('出错', { title: t.notifyErrorTitle, subtitle: truncate(label, 60), body }, TONES.error)
      .catch(error => trace(`error notify failed: ${error?.stack ?? String(error)}`))
  }

  /**
   * A waterfall listener must always delegate: returning nothing would resolve
   * the pending decision to `unavailable` and fail the tool call closed.
   *
   * The announcement runs beside the decision, not before it: delivery spawns a
   * process (and may fall back to a scripted notification), so awaiting it would
   * delay the approval/question UI the human is waiting for.
   * @param {(request: object) => Promise<void>} announce - announcement.
   * @returns {(request: object, next: () => Promise<unknown>) => Promise<unknown>} listener.
   */
  const waterfall = announce => (request, next) => {
    void announce(request).catch(error => trace(`announce failed: ${error?.stack ?? String(error)}`))
    return next()
  }

  /** Wrap an emit listener so a notification failure can never disturb the Host. */
  const emit = listener => (...args) => {
    try {
      listener(...args)
    } catch (error) {
      trace(`listener failed: ${error?.stack ?? String(error)}`)
    }
  }

  ctx.effect(() => ctx.on('approval/request', waterfall(announceApproval)))
  ctx.effect(() => ctx.on('user-questions/request', waterfall(announceQuestion)))
  ctx.effect(() => ctx.on('api-session/added', emit(rememberSession)))
  ctx.effect(() => ctx.on('api-session/status', emit(onSessionStatus)))
  ctx.effect(() => ctx.on('api-session/error', emit(onSessionError)))
  ctx.effect(() => ctx.on('api-session/removed', emit(sessionId => {
    const id = String(sessionId ?? '')
    if (id === '') return
    labels.delete(id)
    runningSince.delete(id)
    lastErrorAt.delete(id)
  })))

  try {
    for (const agent of ctx.get('agents')?.list?.() ?? []) {
      if (agent?.id !== undefined) labels.set(String(agent.id), String(agent.id).slice(0, 12))
    }
  } catch (error) {
    trace(`agent list unavailable: ${error?.message ?? String(error)}`)
  }
  trace(`activated on ${process.platform}; approvals=${String(state.approvals)} questions=${String(state.questions)} finishes=${String(state.finishes)} errors=${String(state.errors)}`)

  /** One settings page owns this plugin's form, so the automatic one stays off. */
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  /**
   * Send the test notice and report both channels.
   * @returns {Promise<{ ok: boolean, banner: string, sound: string, message: string }>} outcome.
   */
  const runTest = async () => {
    const t = text()
    const outcome = await send('自检', {
      title: t.testTitle,
      subtitle: t.testSubtitle,
      body: t.testBody,
    }, TONES.test)
    const message = !outcome.ok
      ? fmt(t.testFailed, { reason: String(outcome.banner) })
      : outcome.channel === 'helper'
        ? (outcome.confirmed === false ? t.testHelperPending : t.testHelperConfirmed)
        : outcome.helper === 'unauthorized' ? t.testUnauthorized
          : outcome.helper === 'denied' ? t.testDenied
            : t.testFallback
    return { ...outcome, message }
  }

  /**
   * Send the test notice and describe the channel around it.
   * @returns {Promise<string>} diagnosis sentence for the status line.
   */
  const runDiagnose = async () => {
    const t = text()
    const outcome = await runTest()
    const app = frontmost()
    const front = app.name === '' ? (app.bundleId === '' ? t.authUnknown : app.bundleId) : app.name
    return fmt(t.diagnoseLine, { message: outcome.message, front, sound: outcome.sound })
  }

  /**
   * Recompute the settings page from a switch change.
   * @param {string} reason - trigger that woke this pass.
   * @returns {Promise<void>} completion.
   */
  const refresh = async reason => {
    if (busy) {
      pendingRefresh = reason
      return
    }
    busy = true
    try {
      if (read('testNow') === true) {
        const outcome = await runTest()
        await writeConfig({ testNow: false, status: `${statusLine()} ${outcome.message}`, details: detailLine() })
        return
      }
      if (read('diagnoseNow') === true) {
        const message = await runDiagnose()
        const t = text()
        const ok = lastError === ''
        await writeConfig({
          diagnoseNow: false,
          status: `${statusLine()} ${ok ? t.selfCheckPass : t.selfCheckFail}`,
          details: `${detailLine()} · ${message}`.slice(0, 400),
        })
        return
      }
      if (read('authorizeNow') === true) {
        const started = requestAuthorization()
        let authorization = 'unknown'
        if (started) {
          for (let attempt = 0; attempt < 6; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 800))
            authorization = helperAuthorization()
            if (authorization === 'authorized' || authorization === 'denied') break
          }
        }
        const t = text()
        const outcome = started === false
          ? t.authMissingHelper
          : authorization === 'authorized'
            ? t.authRequestAllowed
            : authorization === 'denied'
              ? t.authRequestDenied
              : t.authRequestPending
        await writeConfig({
          authorizeNow: false,
          status: `${statusLine()} ${outcome}`,
          details: detailLine(),
        })
        return
      }
      if (read('openSettingsNow') === true) {
        const opened = await openNotificationSettings()
        await writeConfig({
          openSettingsNow: false,
          status: `${statusLine()} ${opened ? text().openSettingsOk : text().openSettingsFail}`,
          details: detailLine(),
        })
        return
      }
      await publish(undefined, { force: true })
    } catch (error) {
      trace(`refresh(${reason}) failed: ${error?.stack ?? String(error)}`)
    } finally {
      busy = false
      if (pendingRefresh !== '') {
        const queued = pendingRefresh
        pendingRefresh = ''
        schedule(queued)
      }
    }
  }

  const schedule = reason => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void refresh(reason)
    }, 150)
  }

  ctx.effect(() => () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (finishTimer !== undefined) clearTimeout(finishTimer)
    finishTimer = undefined
  })

  ctx.on('loader/volatile-update', () => schedule('switch'))
  ctx.on('settings/document-updated', ns => {
    if (typeof ns === 'string' && ns !== 'approval-notify') return
    schedule('settings')
  })
  // A status write can lose the profile lock to an install; the entry settles
  // after pnpm releases it, and a fresh pass then publishes the real status.
  ctx.effect(() => ctx.on('plugin-manager/operation', operation => {
    if (operation?.phase !== 'settled') return
    schedule('plugin-manager')
  }))

  const initial = setTimeout(() => {
    void refresh('activate')
  }, 80)
  ctx.effect(() => () => clearTimeout(initial))

  const definition = {
    name: 'dsh_approval_notify',
    description:
      'Inspect, test, or diagnose the desktop notifications this profile sends while an agent waits for you. `status` reports the '
      + 'switches, the counters, and the last event; `test` sends one notification through the same channel as a real event; '
      + '`diagnose` sends it and also reports the frontmost app and the tone channel. Approval requests only exist while the '
      + 'permission preset asks for approval; under a preset that never asks, nothing is announced. The plugin notifies only — it '
      + 'never answers an approval or a question.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'test', 'diagnose'],
          description: 'status reads the switches and counters; test sends one notification; diagnose adds the channel checks.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'test', 'diagnose'] },
          supported: { type: 'boolean' },
          enabled: { type: 'boolean' },
          approvals: { type: 'boolean' },
          questions: { type: 'boolean' },
          finishes: { type: 'boolean' },
          errors: { type: 'boolean' },
          sound: { type: 'boolean' },
          skipWhenFocused: { type: 'boolean' },
          clickable: { type: 'boolean' },
          scheduled: { type: 'boolean' },
          approvalsSeen: { type: 'integer' },
          questionsSeen: { type: 'integer' },
          finishesSeen: { type: 'integer' },
          errorsSeen: { type: 'integer' },
          lastEvent: { type: 'string' },
          channel: { type: 'string' },
          frontmost: { type: 'string' },
          message: { type: 'string' },
        },
        required: [
          'action',
          'supported',
          'enabled',
          'approvals',
          'questions',
          'finishes',
          'errors',
          'sound',
          'skipWhenFocused',
          'clickable',
          'scheduled',
          'approvalsSeen',
          'questionsSeen',
          'finishesSeen',
          'errorsSeen',
          'lastEvent',
          'channel',
          'frontmost',
          'message',
        ],
        additionalProperties: false,
      },
      render(_args, value) {
        const t = text()
        const onOff = candidate => (candidate ? t.on : t.off)
        const lines = [
          value.supported ? value.channel : t.toolUnsupported,
          fmt(t.toolCounters, {
            approvals: value.approvalsSeen,
            questions: value.questionsSeen,
            finishes: value.finishesSeen,
            errors: value.errorsSeen,
            last: value.lastEvent === '' ? t.statusNever : value.lastEvent,
          }),
          fmt(t.toolSwitches, {
            enabled: onOff(value.enabled),
            approvals: onOff(value.approvals),
            questions: onOff(value.questions),
            finishes: onOff(value.finishes),
            errors: onOff(value.errors),
            sound: onOff(value.sound),
            clickable: onOff(value.clickable),
            scheduled: value.scheduled ? t.scheduledOn : t.scheduledOff,
          }),
          fmt(t.toolFrontmost, { app: value.frontmost }),
        ]
        if (value.message !== '') lines.push(value.message)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      const action = args?.action === 'test' ? 'test' : args?.action === 'diagnose' ? 'diagnose' : 'status'
      let message = ''
      if (action === 'test') {
        const outcome = await runTest()
        message = outcome.message
        await publish(message)
      } else if (action === 'diagnose') {
        message = await runDiagnose()
        await publish(message)
      }
      return {
        action,
        supported: isSupported(),
        enabled: read('enabled') === true,
        approvals: read('approvals') === true,
        questions: read('questions') === true,
        finishes: read('finishes') === true,
        errors: read('errors') === true,
        sound: read('sound') === true,
        skipWhenFocused: read('skipWhenFocused') === true,
        clickable: read('clickable') === true,
        scheduled: read('scheduled') === true,
        approvalsSeen: Number(state.approvals ?? 0),
        questionsSeen: Number(state.questions ?? 0),
        finishesSeen: Number(state.finishes ?? 0),
        errorsSeen: Number(state.errors ?? 0),
        lastEvent: lastEvent(),
        channel: fmt(clickReady() ? text().toolChannelHelper : text().toolChannelOsascript, {
          sound: read('sound') === true ? text().toneSuffix : '',
        }),
        frontmost: frontmost().name === '' ? frontmost().bundleId : frontmost().name,
        message,
      }
    },
  }

  // A distinct name keeps this plugin from colliding with other approval tools;
  // the old name stays registered so existing prompts keep working.
  const alias = {
    ...definition,
    name: 'approval_notify',
    description: 'Deprecated alias of `dsh_approval_notify`; use that name. '
      + definition.description,
  }

  ctx.effect(() => {
    const disposeDefinition = ctx.tools.register(definition)
    const disposeAlias = ctx.tools.register(alias)
    return () => {
      disposeAlias()
      disposeDefinition()
    }
  })
}