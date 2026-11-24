/**
 * Bookkeeping for this plugin: counters and the last event, kept in the running
 * profile's `plugin-data` so the settings page can report them after a restart.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Current state document version. */
export const STATE_VERSION = 2

/** Directory holding this plugin's own data. */
export const DATA_DIRECTORY = 'dsh-approval-notify'

/**
 * Resolve the plugin data directory inside the running profile.
 * @returns {string} absolute directory path.
 */
export function pluginDataDirectory() {
  const fromEnvironment = process.env.DSH_PROFILE_DIR
  if (typeof fromEnvironment === 'string' && fromEnvironment !== '') {
    return path.join(fromEnvironment, 'plugin-data', DATA_DIRECTORY)
  }
  // The desktop host child receives no profile variable; its working directory
  // is the profile root, so prefer it when it carries profile markers.
  const cwd = process.cwd()
  const looksLikeProfile = fs.existsSync(path.join(cwd, 'cordis.patch.yml'))
    || fs.existsSync(path.join(cwd, 'cordis.yml'))
  const base = looksLikeProfile ? cwd : path.join(os.homedir(), '.dsh')
  return path.join(base, 'plugin-data', DATA_DIRECTORY)
}

/**
 * @returns {string} absolute state document path.
 */
export function statePath() {
  return path.join(pluginDataDirectory(), 'state.json')
}

/**
 * Empty counters, also used to normalise a partial or older document.
 * @returns {{ version: number, approvals: number, questions: number, finishes: number, errors: number, lastKind: string, lastAt: string, lastLabel: string, lastBanner: string }} state.
 */
function emptyState() {
  return {
    version: STATE_VERSION,
    approvals: 0,
    questions: 0,
    finishes: 0,
    errors: 0,
    lastKind: '',
    lastAt: '',
    lastLabel: '',
    lastBanner: '',
  }
}

/**
 * Read the state document, tolerating absence and corruption.
 * @returns {{ version: number, approvals: number, questions: number, finishes: number, errors: number, lastKind: string, lastAt: string, lastLabel: string, lastBanner: string }} state.
 */
export function readState() {
  const empty = emptyState()
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return empty
    const merged = { ...empty, ...parsed, version: STATE_VERSION }
    for (const key of ['approvals', 'questions', 'finishes', 'errors']) {
      const value = Number(merged[key])
      merged[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
    }
    return merged
  } catch {
    return empty
  }
}

/**
 * Persist a state patch atomically.
 * @param {object} patch - fields to merge.
 * @returns {object} the stored state.
 */
export function writeState(patch) {
  const next = { ...readState(), ...patch, version: STATE_VERSION }
  try {
    fs.mkdirSync(pluginDataDirectory(), { recursive: true })
    const temporary = `${statePath()}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(next, undefined, 2)}\n`)
    fs.renameSync(temporary, statePath())
  } catch {}
  return next
}

/** Append one bounded diagnostic line beside the plugin state (best effort). */
export function trace(message) {
  try {
    fs.mkdirSync(pluginDataDirectory(), { recursive: true })
    const file = path.join(pluginDataDirectory(), 'debug.log')
    const stat = fs.existsSync(file) ? fs.statSync(file) : undefined
    if (stat !== undefined && stat.size > 64 * 1024) fs.rmSync(file, { force: true })
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}