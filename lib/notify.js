/**
 * macOS notification delivery for this plugin.
 *
 * Two channels, one of them able to handle a click:
 *
 * - **DSH Notify helper** (`helper/DSHNotify.app`): a tiny app bundle built from
 *   `helper/dsh-notify.m` that posts the banner from its own identity, keeps a
 *   run loop alive, and on click activates the DSH desktop app (or opens the
 *   advertised web GUI URL when only `dsh web` runs). macOS asks for the
 *   notification permission once, on first delivery.
 * - **`osascript` fallback**: always available, but macOS attributes the banner
 *   to Script Editor and a scripted banner has no click handler.
 *
 * `sound name` is part of the request on both channels, so the system owns the
 * audio and a plugin-side timeout can never truncate it. macOS does not report
 * whether a banner was presented, only that the request was accepted; the
 * settings page says "submitted" instead of pretending the banner appeared.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Scripted notification entry point. */
export const OSASCRIPT = '/usr/bin/osascript'

/** Alert-tone player, used only when the scripted banner itself fails. */
export const AFPLAY = '/usr/bin/afplay'

/** Bundled alert tone for the fallback path. */
export const SOUND_FILE = '/System/Library/Sounds/Glass.aiff'

/** Recent helper refusal, so a denied channel is not re-probed on every event. */
let helperRefusal = { at: 0, value: '' }

/** Cached `--status` answer; authorization only changes by user action or System Settings. */
let authorizationCache = { at: 0, value: 'unknown' }

/** The helper app bundle and the executable inside it. */
export const HELPER_APP = fileURLToPath(new URL('../helper/DSHNotify.app', import.meta.url))
export const HELPER_BINARY = path.join(HELPER_APP, 'Contents', 'MacOS', 'dsh-notify')

/** Longest body the notification banner keeps readable. */
export const MAX_BODY = 180

/** Tone used per event kind; every name ships with macOS. */
export const TONES = {
  approval: 'Glass',
  question: 'Ping',
  finish: 'Tink',
  error: 'Basso',
  test: 'Glass',
}

/**
 * Flatten one line of arbitrary text for a notification banner.
 * @param {unknown} text - source text, possibly multi-line or empty.
 * @param {number} max - maximum characters kept.
 * @returns {string} single-line, trimmed, length-bounded text.
 */
export function truncate(text, max = MAX_BODY) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Quote text for an AppleScript string literal.
 * @param {unknown} text - text to quote.
 * @returns {string} escaped text without the surrounding quotes.
 */
export function escapeAppleScript(text) {
  return String(text ?? '')
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
}

/**
 * Build the AppleScript source for one notification.
 * @param {{ title: string, subtitle?: string, body: string, sound?: string }} message - content.
 * @returns {string} script source for `osascript -e`.
 */
export function notificationScript({ title, subtitle, body, sound }) {
  const parts = [
    `display notification "${escapeAppleScript(body)}"`,
    `with title "${escapeAppleScript(title)}"`,
  ]
  if (typeof subtitle === 'string' && subtitle !== '') parts.push(`subtitle "${escapeAppleScript(subtitle)}"`)
  if (typeof sound === 'string' && sound !== '') parts.push(`sound name "${escapeAppleScript(sound)}"`)
  return parts.join(' ')
}

/**
 * Run one short-lived command to completion.
 * @param {string} command - absolute executable path.
 * @param {string[]} args - arguments.
 * @param {number} timeoutMs - kill the child after this long.
 * @returns {Promise<{ ok: boolean, error?: string }>} outcome.
 */
export function run(command, args, timeoutMs = 6000) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) })
      return
    }
    let stderr = ''
    let settled = false
    /** @param {{ ok: boolean, error?: string }} outcome */
    const finish = outcome => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish({ ok: false, error: `超时（${timeoutMs}ms）` })
    }, timeoutMs)
    child.stderr?.on('data', chunk => {
      if (stderr.length < 4000) stderr += String(chunk)
    })
    child.on('error', error => finish({ ok: false, error: String(error?.message ?? error) }))
    child.on('exit', code => {
      if (code === 0) {
        finish({ ok: true })
        return
      }
      const tail = stderr.trim().slice(0, 300)
      finish({ ok: false, error: `退出码 ${String(code)}${tail === '' ? '' : `：${tail}`}` })
    })
  })
}

/**
 * Start the detached helper and read its one-line delivery report.
 *
 * The helper prints `ok` from the notification request's completion handler and
 * then stays alive for the click, so waiting for its exit would block for
 * minutes. A process that exits with `denied` (notification permission refused)
 * or `error` is reported so the caller can fall back to the scripted channel
 * instead of dropping the banner silently.
 * @param {string} command - absolute executable path.
 * @param {string[]} args - arguments.
 * @param {number} timeoutMs - how long to wait for the report before assuming an open authorization prompt.
 * @returns {Promise<{ outcome: 'ok' | 'pending' | 'denied' | 'error' | 'missing', error?: string }>} delivery report.
 */
export function launchReport(command, args, timeoutMs = 1800) {
  return new Promise(resolve => {
    let child
    let settled = false
    let timer
    let buffer = ''
    /** @param {'ok' | 'pending' | 'denied' | 'error'} outcome */
    const finish = (outcome, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (outcome === 'ok' || outcome === 'pending') {
        try {
          child.stdout?.destroy()
          child.stderr?.destroy()
          child.unref()
        } catch {}
      } else {
        try {
          child.kill()
        } catch {}
      }
      resolve(error === undefined ? { outcome } : { outcome, error })
    }
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (error) {
      resolve({ outcome: 'error', error: String(error?.message ?? error) })
      return
    }
    child.stdout?.on('data', chunk => {
      buffer += String(chunk)
      if (buffer.includes('ok')) finish('ok')
      else if (buffer.includes('unauthorized')) finish('unauthorized')
      else if (buffer.includes('denied')) finish('denied')
      else if (buffer.includes('error')) finish('error', buffer.trim())
    })
    child.stderr?.on('data', chunk => {
      buffer += String(chunk)
      if (buffer.includes('unauthorized')) finish('unauthorized')
      else if (buffer.includes('denied')) finish('denied')
    })
    child.on('error', error => finish('error', String(error?.message ?? error)))
    child.on('exit', code => {
      if (code === 0) finish('ok')
      else if (code === 2) finish('denied')
      else if (code === 4) finish('unauthorized')
      else finish('error', `退出码 ${String(code)}`)
    })
    timer = setTimeout(() => finish('pending'), timeoutMs)
  })
}

/**
 * Whether this platform can show these notifications at all.
 * @returns {boolean} true on macOS.
 */
export function isSupported() {
  return process.platform === 'darwin'
}

/**
 * Whether the bundled clickable helper is present in this installation.
 * @returns {boolean} true when the helper binary exists.
 */
export function helperAvailable() {
  return isSupported() && existsSync(HELPER_BINARY)
}

/**
 * The helper's notification authorization, as macOS records it.
 *
 * `--status` prints 0 not determined, 1 denied, 2 authorized (3 provisional and
 * 4 ephemeral count as authorized). The answer is cached for 30 s: it only
 * changes when the user acts in System Settings or through the settings page.
 * @returns {'authorized' | 'denied' | 'notDetermined' | 'unknown' | 'missing'} state.
 */
export function helperAuthorization() {
  if (!isSupported() || !existsSync(HELPER_BINARY)) return 'missing'
  if (Date.now() - authorizationCache.at < 30000) return authorizationCache.value
  let value = 'unknown'
  try {
    const result = spawnSync(HELPER_BINARY, ['--status'], { encoding: 'utf8', timeout: 2000 })
    const code = Number(String(result.stdout ?? '').trim())
    value = code === 2 || code === 3 || code === 4 ? 'authorized'
      : code === 1 ? 'denied'
        : code === 0 ? 'notDetermined'
          : 'unknown'
  } catch {}
  authorizationCache = { at: Date.now(), value }
  return value
}

/**
 * Whether the fallback tone is available on this machine.
 * @returns {boolean} true when the bundled Glass sound exists.
 */
export function fallbackToneAvailable() {
  return existsSync(SOUND_FILE)
}

/**
 * Ask macOS for the helper's notification permission, once, on the user's request.
 *
 * Nothing in the delivery path calls this: a banner attempt must never pop a
 * system dialog. The settings page's "请求通知授权" action is the only caller.
 * @returns {boolean} whether the request process started.
 */
export function requestAuthorization() {
  if (!helperAvailable()) return false
  try {
    const child = spawn(HELPER_BINARY, ['--request'], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    helperRefusal = { at: 0, value: '' }
    authorizationCache = { at: 0, value: 'unknown' }
    return true
  } catch {
    return false
  }
}

/**
 * Show one notification, preferring the clickable helper.
 *
 * @param {{ title: string, subtitle?: string, body: string }} message - content.
 * @param {{ sound?: boolean, tone?: string, click?: boolean, bundleId?: string, focusUrl?: string, url?: string }} options - switches.
 * @returns {Promise<{ ok: boolean, banner: string, sound: string, tone: string, channel: 'helper' | 'osascript' | 'none' }>} per-channel results.
 */
export async function deliver(message, options = {}) {
  if (!isSupported()) {
    return { ok: false, banner: '仅支持 macOS', sound: '仅支持 macOS', tone: '', channel: 'none', helper: 'missing', confirmed: false }
  }
  const tone = typeof options.tone === 'string' && options.tone !== '' ? options.tone : TONES.test
  const withSound = options.sound === true

  let helper = options.click === false ? 'off' : 'missing'
  const refusedRecently = helperRefusal.value !== '' && Date.now() - helperRefusal.at < 30000
  if (options.click !== false && helperAvailable() && !refusedRecently) {
    const args = ['--title', message.title]
    if (typeof message.subtitle === 'string' && message.subtitle !== '') args.push('--subtitle', message.subtitle)
    args.push('--body', message.body)
    if (withSound) args.push('--sound', tone)
    if (typeof options.bundleId === 'string' && options.bundleId !== '') args.push('--activate', options.bundleId)
    if (typeof options.focusUrl === 'string' && options.focusUrl !== '') args.push('--focus-url', options.focusUrl)
    if (typeof options.url === 'string' && options.url !== '') args.push('--url', options.url)
    args.push('--identifier', `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
    args.push('--timeout', '30')
    const reported = await launchReport(HELPER_BINARY, args, 1800)
    helper = reported.outcome
    helperRefusal = reported.outcome === 'ok' || reported.outcome === 'pending'
      ? { at: 0, value: '' }
      : { at: Date.now(), value: reported.outcome }
    // `pending` means the helper is waiting for an unanswered authorization
    // prompt; posting the fallback too would show the banner twice once the
    // user allows it, so let the helper own this one.
    if (reported.outcome === 'ok' || reported.outcome === 'pending') {
      return {
        ok: true,
        banner: 'submitted',
        sound: withSound ? `系统提示音 ${tone}` : 'off',
        tone,
        channel: 'helper',
        helper,
        confirmed: reported.outcome === 'ok',
      }
    }
  }

  const banner = await run(OSASCRIPT, ['-e', notificationScript({
    ...message,
    sound: withSound ? tone : undefined,
  })])
  if (banner.ok) {
    return { ok: true, banner: 'submitted', sound: withSound ? `系统提示音 ${tone}` : 'off', tone, channel: 'osascript', helper, confirmed: true }
  }
  if (!withSound || !fallbackToneAvailable()) {
    return { ok: false, banner: banner.error ?? 'failed', sound: 'off', tone, channel: 'osascript', helper, confirmed: false }
  }
  const fallback = await run(AFPLAY, ['-v', '0.6', '-t', '1.8', SOUND_FILE], 6000)
  return {
    ok: false,
    banner: banner.error ?? 'failed',
    sound: fallback.ok ? `已用 afplay 兜底播放 ${tone}` : (fallback.error ?? 'failed'),
    tone,
    channel: 'osascript',
    helper,
    confirmed: false,
  }
}