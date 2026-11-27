/**
 * Pure finish-reminder decisions and message composition.
 *
 * Keeping this out of the Host wiring makes the two rules that caused the most
 * regressions testable without a running Cordis context: when a finish batch
 * stays quiet, and how one or more finished Sessions become one banner.
 */

import { truncate } from './notify.js'

/**
 * Why the current finish batch should stay quiet.
 * @param {{ idleOnly: boolean, idleSeconds: number, idleThreshold: number, focused: boolean, skipWhenFocused: boolean }} input - quiet-mode inputs.
 * @returns {'idle' | 'focused' | null} reason, or null when the batch may be announced.
 */
export function finishSkipReason({ idleOnly, idleSeconds, idleThreshold, focused, skipWhenFocused }) {
  if (idleOnly) return idleSeconds < idleThreshold ? 'idle' : null
  if (skipWhenFocused && focused) return 'focused'
  return null
}

/**
 * Build the single banner for a finish batch.
 * @param {{ label: string, startedAt: number, endedAt: number }[]} items - finished Sessions in arrival order.
 * @param {{ t: object, fmt: Function, language: string, formatDuration: (milliseconds: number) => string }} options - copy and formatting.
 * @returns {{ title: string, subtitle: string, body: string, count: number }} banner content.
 */
export function finishContent(items, { t, fmt, language, formatDuration }) {
  const count = items.length
  if (count === 1) {
    const item = items[0]
    return {
      title: t.notifyFinishTitle,
      subtitle: truncate(item.label, 60),
      body: fmt(t.finishBody, {
        label: item.label,
        duration: formatDuration(item.endedAt - item.startedAt),
      }),
      count,
    }
  }
  const labels = [...new Set(items.map(item => item.label))]
  const separator = language === 'en' ? ', ' : '、'
  const body = labels.length > 3
    ? fmt(t.finishBatchBodyMore, { labels: labels.slice(0, 3).join(separator), count })
    : fmt(t.finishBatchBody, { labels: labels.join(separator) })
  return {
    title: t.notifyFinishTitle,
    subtitle: fmt(t.finishBatchSubtitle, { count }),
    body: truncate(body),
    count,
  }
}