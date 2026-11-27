/**
 * Readable Session labels that stay distinct when several sessions share a
 * directory. `SessionSummary` has no title, so the folder name plus a short id
 * is the most useful stable label available.
 */

import path from 'node:path'

/**
 * Build the notification label for one Session.
 * @param {string} id - Session id.
 * @param {string} [cwd] - working directory, when known.
 * @returns {string} folder name with a four-character id suffix, or the id alone.
 */
export function sessionLabel(id, cwd) {
  const identifier = String(id ?? '')
  const directory = typeof cwd === 'string' && cwd !== '' ? path.basename(cwd) : ''
  if (directory === '') return identifier.slice(0, 12)
  return `${directory} · ${identifier.slice(0, 4)}`
}
