/**
 * macOS system probes for this plugin.
 *
 * Two questions matter before a notification is worth sending: is the user
 * already looking at DSH, and can we open the notification settings pane when
 * the banner stays invisible. Both are answered with commands that ship with
 * macOS, so the plugin keeps its zero-dependency footprint.
 */

import { spawn, spawnSync } from 'node:child_process'

/** Bundle id of the DSH desktop app; the window the user is looking at. */
export const DSH_BUNDLE_ID = 'com.deepseek.dsh'

/** LaunchServices inspection tool, present since macOS 10.9. */
export const LSAPPINFO = '/usr/bin/lsappinfo'

/** Opens a `x-apple.systempreferences:` pane. */
export const OPEN = '/usr/bin/open'

/** IOKit registry tool, used for the idle time. */
export const IOREG = '/usr/sbin/ioreg'

/** Notification settings pane (macOS 13+ extension URL). */
export const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'

/** How long the frontmost answer stays fresh; detail lines repeat within seconds. */
const FRONTMOST_TTL_MS = 5000

/** How long the idle answer stays fresh. */
const IDLE_TTL_MS = 5000

/** @type {{ at: number, bundleId: string, name: string }} */
let frontmostCache = { at: 0, bundleId: '', name: '' }

/** @type {{ at: number, seconds: number }} */
let idleCache = { at: 0, seconds: 0 }

/**
 * Run one command and return its stdout, or an empty string on any failure.
 * @param {string} command - absolute executable path.
 * @param {string[]} args - arguments.
 * @param {number} timeoutMs - give up after this long.
 * @returns {string} trimmed stdout.
 */
function readText(command, args, timeoutMs = 1500) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs })
    if (result.error !== undefined && result.error !== null) return ''
    if (typeof result.status === 'number' && result.status !== 0) return ''
    return String(result.stdout ?? '')
  } catch {
    return ''
  }
}

/**
 * The app currently in front of the user.
 *
 * `lsappinfo front` prints the front application's Apple event serial number;
 * a second call resolves that serial number to the bundle id. Focused windows
 * without a bundle (rare helpers) resolve to an empty id, which is treated as
 * "not DSH".
 * @returns {{ bundleId: string, name: string }} frontmost app identity.
 */
export function frontmost() {
  const now = Date.now()
  if (now - frontmostCache.at < FRONTMOST_TTL_MS) return frontmostCache
  const serial = readText(LSAPPINFO, ['front'])
  const match = serial.match(/ASN:0x[0-9a-fx-]+/i)
  let bundleId = ''
  let name = ''
  if (match !== null) {
    // With `name` among the requested keys, `lsappinfo info` prints the display
    // name on its first line; without it the first line is `[ NULL ]`.
    const info = readText(LSAPPINFO, ['info', '-only', 'bundleid', 'name', match[0]])
    const id = info.match(/bundleID="([^"]*)"/)
    if (id !== null) bundleId = id[1]
    const label = info.match(/^"([^"]*)"/m)
    if (label !== null) name = label[1]
  }
  frontmostCache = { at: now, bundleId, name }
  return frontmostCache
}

/**
 * Whether DSH itself is the frontmost app.
 * @returns {boolean} true when the user is already looking at DSH.
 */
export function dshIsFrontmost() {
  return frontmost().bundleId === DSH_BUNDLE_ID
}

/**
 * Seconds since the last keyboard or pointer input.
 *
 * `HIDIdleTime` is the system's own idle counter; asking it is far more reliable
 * than guessing whether a browser window belongs to DSH.
 * @returns {number} idle seconds, or 0 when the value cannot be read.
 */
export function idleSeconds() {
  if (Date.now() - idleCache.at < IDLE_TTL_MS) return idleCache.seconds
  const text = readText(IOREG, ['-c', 'IOHIDSystem'], 2000)
  const match = text.match(/"HIDIdleTime"\s*=\s*(\d+)/)
  const seconds = match === null ? 0 : Number(match[1]) / 1e9
  idleCache = { at: Date.now(), seconds }
  return seconds
}

/**
 * Open System Settings on the Notifications pane.
 *
 * A silent banner is almost always a permission or Focus question, and the only
 * place to answer it is this pane. Opening it is best-effort: a headless or
 * remote session simply reports `false`.
 * @returns {Promise<boolean>} whether `open` accepted the URL.
 */
export function openNotificationSettings() {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(OPEN, [NOTIFICATION_SETTINGS_URL], { stdio: 'ignore' })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('exit', code => resolve(code === 0))
  })
}