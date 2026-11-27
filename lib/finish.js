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
 * @param {{ mode: 'off' | 'focused' | 'idle', idleSeconds: number, idleThreshold: number, focused: boolean }} input - quiet-mode inputs.
 * @returns {'idle' | 'focused' | null} reason, or null when the batch may be announced.
 */
export function finishSkipReason({ mode, idleSeconds, idleThreshold, focused }) {
  if (mode === 'idle') return idleSeconds < idleThreshold ? 'idle' : null
  if (mode === 'focused' && focused) return 'focused'
  return null
}

/**
 * Build the single banner for a finish batch.
 * @param {{ label: string, startedAt: number, endedAt: number }[]} items - finished Sessions in arrival order.
 * @param {{ t: object, fmt: Function, language: string, formatDuration: (milliseconds: number) => string, redact?: boolean }} options - copy and formatting.
 * @returns {{ title: string, subtitle: string, body: string, count: number }} banner content.
 */
export function finishContent(items, { t, fmt, language, formatDuration, redact = false }) {
  const count = items.length
  if (redact) {
    if (count === 1) {
      return {
        title: t.notifyFinishTitle,
        subtitle: t.finishPrivateSubtitle,
        body: fmt(t.finishPrivateBody, {
          duration: formatDuration(items[0].endedAt - items[0].startedAt),
        }),
        count,
      }
    }
    return {
      title: t.notifyFinishTitle,
      subtitle: fmt(t.finishBatchSubtitle, { count }),
      body: fmt(t.finishBatchPrivateBody, { count }),
      count,
    }
  }
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