/**
 * macOS notification delivery for this plugin.
 *
 * A Host plugin runs outside the Electron main process, so it cannot use
 * Electron's Notification API. Notification Center accepts a scripted request
 * from `osascript`, and the alert tone rides along with that request through
 * `sound name`, so the system owns the audio: no truncation, no second process,
 * and the banner and the tone stay in step.
 *
 * macOS does not report whether the banner was presented, only whether the
 * request was accepted (exit code 0). Focus modes and a disabled notification
 * permission are therefore reported as "submitted", not "seen"; the settings
 * page says so instead of pretending the banner appeared.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Scripted notification entry point. */
export const OSASCRIPT = '/usr/bin/osascript'

/** Alert-tone player, used only when the scripted banner itself fails. */
export const AFPLAY = '/usr/bin/afplay'

/** Bundled alert tone for the fallback path. */
export const SOUND_FILE = '/System/Library/Sounds/Glass.aiff'

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
 *
 * Backslashes and double quotes would otherwise end the literal, and control
 * characters would break the single-line script source.
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
 *
 * `sound name` is part of the request, so Notification Center plays the tone
 * itself; `afplay` is only the fallback for a rejected script.
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
 * Run one short-lived command without blocking the caller.
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
 * Whether this platform can show these notifications at all.
 * @returns {boolean} true on macOS.
 */
export function isSupported() {
  return process.platform === 'darwin'
}

/**
 * Whether the fallback tone is available on this machine.
 * @returns {boolean} true when the bundled Glass sound exists.
 */
export function fallbackToneAvailable() {
  return existsSync(SOUND_FILE)
}

/**
 * Show one notification, and let the system play its tone when asked.
 *
 * The tone is requested inside the notification itself, so macOS mutes,
 * Focus modes and the per-app sound switch all apply exactly as they do for
 * any other app. When the scripted request is rejected outright, `afplay`
 * plays the tone independently so an audible channel still exists.
 * @param {{ title: string, subtitle?: string, body: string }} message - content.
 * @param {{ sound?: boolean, tone?: string }} options - channel switches and tone name.
 * @returns {Promise<{ ok: boolean, banner: string, sound: string, tone: string }>} per-channel results.
 */
export async function deliver(message, options = {}) {
  if (!isSupported()) {
    return { ok: false, banner: '仅支持 macOS', sound: '仅支持 macOS', tone: '' }
  }
  const tone = typeof options.tone === 'string' && options.tone !== '' ? options.tone : TONES.test
  const withSound = options.sound === true
  const banner = await run(OSASCRIPT, ['-e', notificationScript({
    ...message,
    sound: withSound ? tone : undefined,
  })])
  if (banner.ok) {
    return { ok: true, banner: 'submitted', sound: withSound ? `系统提示音 ${tone}` : 'off', tone }
  }
  if (!withSound || !fallbackToneAvailable()) {
    return { ok: false, banner: banner.error ?? 'failed', sound: 'off', tone }
  }
  const fallback = await run(AFPLAY, ['-v', '0.6', '-t', '1.8', SOUND_FILE], 6000)
  return {
    ok: false,
    banner: banner.error ?? 'failed',
    sound: fallback.ok ? `已用 afplay 兜底播放 ${tone}` : (fallback.error ?? 'failed'),
    tone,
  }
}