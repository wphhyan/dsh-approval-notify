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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
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

/** The helper app bundle and the executable shipped inside this package. */
export const HELPER_APP = fileURLToPath(new URL('../helper/DSHNotify.app', import.meta.url))
export const HELPER_BINARY = path.join(HELPER_APP, 'Contents', 'MacOS', 'dsh-notify')

/**
 * A stable copy of the helper under Application Support.
 *
 * `node_modules` is replaced on every plugin upgrade and removed on uninstall;
 * notifications from the previous version then point at a bundle that no longer
 * exists. A copy with the same bundle id in Application Support survives
 * upgrades, so LaunchServices always has a launchable app for the click.
 */
const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'dsh-approval-notify')
export const STABLE_APP = path.join(APP_SUPPORT, 'DSHNotify.app')
export const STABLE_BINARY = path.join(STABLE_APP, 'Contents', 'MacOS', 'dsh-notify')
const VERSION_FILE = path.join(STABLE_APP, 'dsh-version.txt')
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version ?? '0'
  } catch {
    return '0'
  }
})()

/** Whether the stable copy has already been prepared in this process. */
let helperChecked = false
let helperReady = false

/**
 * Prepare (copy + register) the stable helper copy once per process.
 * @returns {boolean} true when the stable binary exists.
 */
export function ensureHelper() {
  if (!isSupported()) return false
  if (helperChecked) return helperReady
  if (!existsSync(HELPER_BINARY)) return false
  try {
    const binaryStat = statSync(HELPER_BINARY)
    const fingerprint = `${PACKAGE_VERSION}:${String(binaryStat.size)}:${String(Math.round(binaryStat.mtimeMs))}`
    let installed = '0'
    try { installed = readFileSync(VERSION_FILE, 'utf8').trim() } catch {}
    if (installed !== fingerprint) {
      mkdirSync(APP_SUPPORT, { recursive: true })
      rmSync(STABLE_APP, { recursive: true, force: true })
      cpSync(HELPER_APP, STABLE_APP, { recursive: true })
      try { spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', STABLE_APP], { timeout: 2000 }) } catch {}
      writeFileSync(VERSION_FILE, `${fingerprint}\n`)
    }
    if (existsSync(STABLE_BINARY)) {
      // Register the bundle under the same id so click resolution never depends
      // on the package path that is about to be replaced.
      spawnSync(LSREGISTER, ['-f', STABLE_APP], { timeout: 3000 })
      helperChecked = true
      helperReady = true
    }
  } catch {}
  return helperReady
}

/** Path of the helper executable to run (stable copy when available). */
function helperBinary() {
  return ensureHelper() ? STABLE_BINARY : HELPER_BINARY
}

/** Path of the helper app bundle to launch (stable copy when available). */
function helperApp() {
  return ensureHelper() ? STABLE_APP : HELPER_APP
}

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
 * Run one short-lived command and capture stdout/stderr.
 * @param {string} command - absolute executable path.
 * @param {string[]} args - arguments.
 * @param {number} timeoutMs - kill the child after this long.
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, error?: string }>} outcome.
 */
export function runCapture(command, args, timeoutMs = 1500) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', error: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = outcome => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ ok: false, stdout, stderr, error: `超时（${timeoutMs}ms）` })
    }, timeoutMs)
    child.stdout?.on('data', chunk => { if (stdout.length < 4000) stdout += String(chunk) })
    child.stderr?.on('data', chunk => { if (stderr.length < 4000) stderr += String(chunk) })
    child.on('error', error => finish({ ok: false, stdout, stderr, error: String(error?.message ?? error) }))
    child.on('exit', code => finish({
      ok: code === 0,
      stdout,
      stderr,
      ...code === 0 ? {} : { error: `退出码 ${String(code)}` },
    }))
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
export function launchReport(command, args, timeoutMs = 1800, env) {
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
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        ...env === undefined ? {} : { env },
      })
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
 * Launch the helper app through LaunchServices and wait for its report file.
 *
 * Spawning the helper executable directly leaves it as an anonymous process
 * (`anon<dsh-notify>` in RunningBoard). When the user clicks such a banner the
 * system cannot bring the anonymous process forward and CoreServicesUIAgent
 * reports `procNotFound` (-600), which surfaces as "DSHNotify.app can no longer
 * be opened". Going through `open -n -a` makes the helper a real app instance,
 * so the notification response has a process to land on; the helper writes its
 * delivery result into `--report` because stdout is not attached.
 *
 * @param {string} appPath - helper .app bundle path.
 * @param {string[]} args - helper arguments (the report path is appended).
 * @param {number} timeoutMs - how long to wait for the report file.
 * @param {NodeJS.ProcessEnv} [env] - environment for the app.
 * @returns {Promise<{ outcome: 'ok' | 'pending' | 'denied' | 'unauthorized' | 'error', error?: string }>} delivery report.
 */
function launchApp(appPath, args, timeoutMs, env) {
  return new Promise(resolve => {
    const report = path.join(os.tmpdir(), `dsh-notify-${String(process.pid)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.report`)
    let settled = false
    const finish = (outcome, error) => {
      if (settled) return
      settled = true
      try { unlinkSync(report) } catch {}
      resolve(error === undefined ? { outcome } : { outcome, error })
    }
    let opener
    try {
      opener = spawn('/usr/bin/open', ['-n', '-a', appPath, '--args', ...args, '--report', report], {
        stdio: 'ignore',
        ...env === undefined ? {} : { env },
      })
    } catch (error) {
      resolve({ outcome: 'error', error: String(error?.message ?? error) })
      return
    }
    opener.on('error', error => finish('error', String(error?.message ?? error)))
    opener.on('exit', code => {
      if (code !== 0) finish('error', `open 退出码 ${String(code)}`)
    })
    const started = Date.now()
    const poll = () => {
      if (settled) return
      try {
        if (existsSync(report)) {
          const text = readFileSync(report, 'utf8').trim()
          if (text.startsWith('ok')) return finish('ok')
          if (text.startsWith('unauthorized')) return finish('unauthorized')
          if (text.startsWith('denied')) return finish('denied')
          if (text.startsWith('error')) return finish('error', text)
        }
      } catch {}
      if (Date.now() - started >= timeoutMs) return finish('pending')
      setTimeout(poll, 50)
    }
    setTimeout(poll, 50)
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
  return isSupported() && (ensureHelper() || existsSync(HELPER_BINARY))
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
  if (!isSupported() || !helperAvailable()) return 'missing'
  return authorizationCache.value
}

/**
 * Refresh the cached authorization by asking the helper, off the event loop.
 * @returns {Promise<'authorized' | 'denied' | 'notDetermined' | 'unknown' | 'missing'>} fresh state.
 */
export async function refreshHelperAuthorization() {
  if (!isSupported() || !helperAvailable()) {
    authorizationCache = { at: Date.now(), value: 'missing' }
    return 'missing'
  }
  const result = await runCapture(helperBinary(), ['--status'], 1500)
  let value = 'unknown'
  if (result.ok) {
    const code = Number(String(result.stdout ?? '').trim())
    value = code === 2 || code === 3 || code === 4 ? 'authorized'
      : code === 1 ? 'denied'
        : code === 0 ? 'notDetermined'
          : 'unknown'
  }
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
    const child = spawn(helperBinary(), ['--request'], { stdio: 'ignore', detached: true })
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
    args.push('--identifier', `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
    args.push('--timeout', '30')
    // The advertised URL embeds the session token; hand it over in the environment
    // so it never shows up in this process's arguments.
    const environment = typeof options.url === 'string' && options.url !== ''
      ? { ...process.env, DSH_NOTIFY_URL: options.url }
      : undefined
    const reported = await launchApp(helperApp(), args, 1800, environment)
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