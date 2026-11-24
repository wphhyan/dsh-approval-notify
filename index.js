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
import { createRequire } from 'node:module'
import { TONES, deliver, isSupported, truncate } from './lib/notify.js'
import { readState, trace, writeState } from './lib/state.js'
import { dshIsFrontmost, frontmost, openNotificationSettings } from './lib/system.js'

export const name = 'approval-notify'

export const inject = ['tools', 'configEditor']

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
  const anchor = process.env.DSH_INSTALL_DIR ?? ''
  const resolved = require.resolve('@deepseek-ai/schemastery', { paths: [anchor] })
  const loaded = require(resolved)
  return loaded.default ?? loaded
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
  testNow: z.boolean().default(false).volatile()
    .description('「发送测试通知」：打开后立即发一条测试通知，完成或失败后自动关闭。'),
  diagnoseNow: z.boolean().default(false).volatile()
    .description('「自检」：打开后发一条测试通知并报告通道、前台应用与兜底音源，完成后自动关闭。'),
  openSettingsNow: z.boolean().default(false).volatile()
    .description('「打开系统通知设置」：打开后跳到 macOS 通知设置面板，完成后自动关闭。'),
  status: z.string().default('').volatile()
    .description('只读状态：渠道、计数与最近一次事件，由插件写回，无需编辑。'),
  details: z.string().default('').volatile()
    .description('只读：渠道、前台应用、声音来源与排查提示。'),
})

/** How long one repeated call id is treated as already announced. */
const DEDUPE_MS = 3000

/** A Session that flaps running→idle→running keeps one finish reminder per interval. */
const FINISH_QUIET_MS = 5000

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
function duration(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000))
  if (total < 60) return `${String(total)} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${String(minutes)} 分` : `${String(minutes)} 分 ${String(seconds)} 秒`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(rest)} 分`
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
  /** @type {Map<string, number>} Session id → last finish reminder. */
  const lastFinish = new Map()
  /** Counters are read from disk once per activation and kept in memory. */
  let state = readState()
  let lastBanner = ''
  let lastError = ''
  let lastSkip = ''
  let busy = false
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
    try {
      await outsideHmr(() => editor.edit(entry, current => ({ ...current, ...patch })))
      trace(`config write ok: ${JSON.stringify(patch)}`)
      return true
    } catch (error) {
      trace(`config write failed: ${error?.message ?? String(error)}`)
      return false
    }
  }

  /** Active notification sources, for the status line. */
  const channels = () => {
    const list = []
    if (read('approvals') === true) list.push('审批')
    if (read('questions') === true) list.push('提问')
    if (read('finishes') === true) list.push('完成')
    if (read('errors') === true) list.push('出错')
    return list
  }

  /** One-line status shared by the settings page and the tool. */
  const statusLine = () => {
    const total = Number(state.approvals ?? 0) + Number(state.questions ?? 0)
      + Number(state.finishes ?? 0) + Number(state.errors ?? 0)
    if (!isSupported()) return '当前平台不是 macOS：通知渠道不可用。'
    if (read('enabled') !== true) return `已关闭：审批、提问、完成、出错都不提醒（本次启动已记录 ${String(total)} 条）。`
    const active = channels()
    if (active.length === 0) return '已开启但没有勾选任何事件来源：不会发送通知。'
    const last = state.lastLabel === ''
      ? '还没有触发过'
      : `最近 ${clock(state.lastAt)} ${String(state.lastKind)} ${state.lastLabel}`
    return `通知中：${active.join(' + ')} · 审批 ${String(state.approvals ?? 0)} · 提问 ${String(state.questions ?? 0)}`
      + ` · 完成 ${String(state.finishes ?? 0)} · 出错 ${String(state.errors ?? 0)} · ${last}`
  }

  /** Multi-line diagnostics for the settings page. */
  const detailLine = () => {
    const parts = []
    parts.push(`渠道：osascript display notification（横幅在系统里显示为「脚本编辑器 / Script Editor」）${read('sound') === true ? '，提示音随横幅交给系统播放' : '，不播放提示音'}`)
    const app = frontmost()
    parts.push(`前台：${app.name === '' ? (app.bundleId === '' ? '未知' : app.bundleId) : app.name}${read('skipWhenFocused') === true ? '（DSH 在前台时跳过「完成」提醒）' : ''}`)
    if (lastBanner !== '') parts.push(`横幅：${lastBanner}`)
    if (lastSkip !== '') parts.push(`跳过：${lastSkip}`)
    if (lastError !== '') parts.push(`错误：${lastError}`)
    parts.push('审批请求只在权限模式的审批为「询问」（只读 / 工作区写入）时出现，「完全访问」会直接拒绝需要审批的操作')
    return parts.join(' · ').slice(0, 400)
  }

  /**
   * Publish the current status into the plugin's own config fields.
   * @param {string} [message] - extra sentence appended to the status line.
   * @returns {Promise<void>} completion.
   */
  const publish = async message => {
    const status = `${statusLine()}${message === undefined || message === '' ? '' : ` ${message}`}`
    if (read('status') === status && read('details') === detailLine()) return
    await writeConfig({ status, details: detailLine() })
  }

  /**
   * Show one notification and record it.
   * @param {'审批'|'提问'|'完成'|'出错'|'自检'} kind - event kind.
   * @param {{ title: string, subtitle?: string, body: string }} message - content.
   * @param {string} [tone] - alert tone name.
   * @returns {Promise<{ ok: boolean, banner: string, sound: string, error?: string }>} outcome.
   */
  const send = async (kind, message, tone) => {
    if (!isSupported()) return { ok: false, banner: '仅支持 macOS', sound: 'off', error: '仅支持 macOS' }
    const outcome = await deliver(message, { sound: read('sound') === true, tone })
    lastBanner = outcome.banner === 'submitted' ? `已提交给通知中心（${clock(new Date().toISOString())}）` : outcome.banner
    lastError = outcome.ok ? '' : String(outcome.banner)
    trace(`notify(${kind}) banner=${outcome.banner} sound=${outcome.sound} title=${message.title}`)
    if (outcome.ok) {
      const next = {
        lastKind: kind,
        lastAt: new Date().toISOString(),
        lastLabel: message.subtitle ?? truncate(message.body, 24),
        lastBanner,
      }
      const counter = COUNTERS[kind]
      state = writeState(counter === undefined ? next : { ...next, [counter]: Number(state[counter] ?? 0) + 1 })
    }
    return outcome.ok
      ? { ok: true, banner: outcome.banner, sound: outcome.sound }
      : { ok: false, banner: outcome.banner, sound: outcome.sound, error: lastError }
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
    const tool = typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : '工具调用'
    const display = request?.displayReason
    const reason = typeof display?.zh === 'string' && display.zh !== ''
      ? display.zh
      : typeof display?.en === 'string' && display.en !== ''
        ? display.en
        : typeof request?.reason === 'string' ? request.reason : ''
    const body = reason === '' ? `${tool} 请求你授权后才能继续` : truncate(reason)
    await send('审批', { title: 'DSH 等你授权', subtitle: truncate(tool, 60), body }, TONES.approval)
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
    await send('提问', { title: 'DSH 等你回答', subtitle: header === undefined ? undefined : truncate(header, 60), body }, TONES.question)
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
    if (running === true) {
      runningSince.set(id, Date.now())
      return
    }
    const started = runningSince.get(id)
    runningSince.delete(id)
    if (started === undefined) return
    if (read('enabled') !== true || read('finishes') !== true) return
    if (suppressed(`finish:${id}`, FINISH_QUIET_MS)) return
    if (read('skipWhenFocused') === true && dshIsFrontmost()) {
      lastSkip = `DSH 在前台，${clock(new Date().toISOString())} 的「完成」提醒已跳过`
      return
    }
    lastSkip = ''
    const label = labels.get(id) ?? id.slice(0, 12)
    void send('完成', {
      title: 'DSH 回合完成',
      subtitle: truncate(label, 60),
      body: `${label} 已跑完，用时 ${duration(Date.now() - started)}。回到 DSH 查看结果。`,
    }, TONES.finish).catch(error => trace(`finish notify failed: ${error?.stack ?? String(error)}`))
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
    if (suppressed(`error:${id}`)) return
    const label = labels.get(id) ?? id.slice(0, 12)
    const text = truncate(typeof message === 'string' && message !== '' ? message : '会话出错，需要你看一下。')
    void send('出错', { title: 'DSH 会话出错', subtitle: truncate(label, 60), body: text }, TONES.error)
      .catch(error => trace(`error notify failed: ${error?.stack ?? String(error)}`))
  }

  /**
   * A waterfall listener must always delegate: returning nothing would resolve
   * the pending decision to `unavailable` and fail the tool call closed.
   * @param {(request: object) => Promise<void>} announce - announcement.
   * @returns {(request: object, next: () => Promise<unknown>) => Promise<unknown>} listener.
   */
  const waterfall = announce => async (request, next) => {
    try {
      await announce(request)
    } catch (error) {
      trace(`announce failed: ${error?.stack ?? String(error)}`)
    }
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

  /** Content of the test notification, shared by the switch, the page and the tool. */
  const TEST_MESSAGE = {
    title: 'DSH 通知自检',
    subtitle: '测试通知',
    body: '看到这条横幅就说明通道可用；审批、提问、完成、出错会用同样的方式提醒你。',
  }

  /**
   * Send the test notice and report both channels.
   * @returns {Promise<{ ok: boolean, banner: string, sound: string, message: string }>} outcome.
   */
  const runTest = async () => {
    const outcome = await send('自检', TEST_MESSAGE, TONES.test)
    return {
      ...outcome,
      message: outcome.ok
        ? '测试通知已提交给通知中心。若没有横幅，检查系统设置里「脚本编辑器 / Script Editor」的通知权限与专注模式。'
        : `测试通知失败：${String(outcome.banner)}`,
    }
  }

  /**
   * Send the test notice and describe the channel around it.
   * @returns {Promise<string>} diagnosis sentence for the status line.
   */
  const runDiagnose = async () => {
    const outcome = await runTest()
    const app = frontmost()
    const front = app.name === '' ? (app.bundleId === '' ? '未知' : app.bundleId) : app.name
    return `${outcome.message} 前台应用：${front}；提示音：${outcome.sound}。`
  }

  /**
   * Recompute the settings page from a switch change.
   * @param {string} reason - trigger that woke this pass.
   * @returns {Promise<void>} completion.
   */
  const refresh = async reason => {
    if (busy) return
    busy = true
    try {
      if (read('testNow') === true) {
        const outcome = await runTest()
        await writeConfig({ testNow: false, status: `${statusLine()} ${outcome.message}`, details: detailLine() })
        return
      }
      if (read('diagnoseNow') === true) {
        const message = await runDiagnose()
        const ok = lastError === ''
        await writeConfig({
          diagnoseNow: false,
          status: `${statusLine()} 自检${ok ? '通过' : '失败'}。`,
          details: `${detailLine()} · 自检：${message}`.slice(0, 400),
        })
        return
      }
      if (read('openSettingsNow') === true) {
        const opened = await openNotificationSettings()
        await writeConfig({
          openSettingsNow: false,
          status: opened
            ? `${statusLine()} 已打开系统通知设置。`
            : `${statusLine()} 无法打开系统设置，请手动进入「系统设置 → 通知」。`,
          details: detailLine(),
        })
        return
      }
      await publish()
    } catch (error) {
      trace(`refresh(${reason}) failed: ${error?.stack ?? String(error)}`)
    } finally {
      busy = false
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
  })

  ctx.on('loader/volatile-update', () => schedule('switch'))
  ctx.on('settings/document-updated', () => schedule('settings'))

  const initial = setTimeout(() => {
    void refresh('activate')
  }, 80)
  ctx.effect(() => () => clearTimeout(initial))

  /** Last-event sentence shared by the tool output and the settings page. */
  const lastEvent = () => state.lastLabel === ''
    ? ''
    : `${clock(state.lastAt)} ${String(state.lastKind)} ${state.lastLabel}`

  const definition = {
    name: 'approval_notify',
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
        const lines = [
          value.supported ? value.channel : '当前平台不是 macOS，通知渠道不可用。',
          `审批 ${value.approvalsSeen} · 提问 ${value.questionsSeen} · 完成 ${value.finishesSeen} · 出错 ${value.errorsSeen}`
            + ` · 最近 ${value.lastEvent === '' ? '还没有触发过' : value.lastEvent}`,
          `开关：总开关${value.enabled ? '开' : '关'} · 审批${value.approvals ? '开' : '关'} · 提问${value.questions ? '开' : '关'}`
            + ` · 完成${value.finishes ? '开' : '关'} · 出错${value.errors ? '开' : '关'} · 提示音${value.sound ? '开' : '关'}`,
          `前台：${value.frontmost}`,
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
        approvalsSeen: Number(state.approvals ?? 0),
        questionsSeen: Number(state.questions ?? 0),
        finishesSeen: Number(state.finishes ?? 0),
        errorsSeen: Number(state.errors ?? 0),
        lastEvent: lastEvent(),
        channel: `osascript display notification${read('sound') === true ? ' + 系统提示音' : ''}`,
        frontmost: frontmost().name === '' ? frontmost().bundleId : frontmost().name,
        message,
      }
    },
  }

  ctx.effect(() => ctx.tools.register(definition))
}