import test from 'node:test'
import assert from 'node:assert/strict'
import { finishContent, finishSkipReason } from '../lib/finish.js'

/** Minimal formatter mirroring lib/messages.js `fmt`. */
const fmt = (template, variables = {}) => String(template).replace(/\{([a-zA-Z]+)\}/gu,
  (match, key) => (key in variables ? String(variables[key]) : match))

const t = {
  notifyFinishTitle: 'DSH 回合完成',
  finishBody: '{label} 已跑完，用时 {duration}。回到 DSH 查看结果。',
  finishBatchSubtitle: '{count} 个会话',
  finishBatchBody: '{labels} 已跑完，回到 DSH 查看结果。',
  finishBatchBodyMore: '{labels} 等 {count} 个会话已跑完，回到 DSH 查看结果。',
}

const formatDuration = milliseconds => `${Math.round(milliseconds / 1000)} 秒`

test('a single finish keeps its label and duration', () => {
  const content = finishContent(
    [{ label: 'demo', startedAt: 1000, endedAt: 61_000 }],
    { t, fmt, language: 'zh', formatDuration },
  )
  assert.equal(content.count, 1)
  assert.equal(content.subtitle, 'demo')
  assert.equal(content.body, 'demo 已跑完，用时 60 秒。回到 DSH 查看结果。')
})

test('a batch merges labels and counts every session', () => {
  const content = finishContent(
    [
      { label: 'api', startedAt: 0, endedAt: 10_000 },
      { label: 'web', startedAt: 0, endedAt: 10_000 },
      { label: 'api', startedAt: 0, endedAt: 10_000 },
    ],
    { t, fmt, language: 'zh', formatDuration },
  )
  assert.equal(content.count, 3)
  assert.equal(content.subtitle, '3 个会话')
  assert.equal(content.body, 'api、web 已跑完，回到 DSH 查看结果。')
})

test('more than three distinct labels become an ellipsis summary', () => {
  const content = finishContent(
    ['a', 'b', 'c', 'd'].map(label => ({ label, startedAt: 0, endedAt: 1000 })),
    { t, fmt, language: 'en', formatDuration },
  )
  assert.equal(content.count, 4)
  assert.equal(content.subtitle, '4 个会话')
  assert.equal(content.body, 'a, b, c 等 4 个会话已跑完，回到 DSH 查看结果。')
})

test('idle mode skips below the threshold and allows at it', () => {
  const base = { idleOnly: true, idleSeconds: 59, idleThreshold: 60, focused: true, skipWhenFocused: true }
  assert.equal(finishSkipReason(base), 'idle')
  assert.equal(finishSkipReason({ ...base, idleSeconds: 60 }), null)
})

test('focus mode only skips while DSH is frontmost', () => {
  const base = { idleOnly: false, idleSeconds: 0, idleThreshold: 60, focused: true, skipWhenFocused: true }
  assert.equal(finishSkipReason(base), 'focused')
  assert.equal(finishSkipReason({ ...base, focused: false }), null)
  assert.equal(finishSkipReason({ ...base, skipWhenFocused: false }), null)
})