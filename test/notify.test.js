import test from 'node:test'
import assert from 'node:assert/strict'
import { TONES, escapeAppleScript, notificationScript, truncate } from '../lib/notify.js'

test('truncate flattens whitespace and bounds the banner body', () => {
  assert.equal(truncate('  a\n\nb\tc  '), 'a b c')
  const long = 'x'.repeat(400)
  const clipped = truncate(long)
  assert.equal(clipped.length, 180)
  assert.ok(clipped.endsWith('…'))
  assert.equal(truncate(undefined), '')
})

test('escapeAppleScript keeps the AppleScript literal intact', () => {
  assert.equal(escapeAppleScript('a "b" \\ c'), 'a \\"b\\" \\\\ c')
  assert.equal(escapeAppleScript('line\u0007break'), 'line break')
  assert.equal(escapeAppleScript(undefined), '')
})

test('notificationScript carries subtitle and sound', () => {
  assert.equal(
    notificationScript({ title: 'T', subtitle: 'S', body: 'B', sound: 'Glass' }),
    'display notification "B" with title "T" subtitle "S" sound name "Glass"',
  )
})

test('notificationScript omits empty optional parts', () => {
  assert.equal(notificationScript({ title: 'T', body: 'B' }), 'display notification "B" with title "T"')
  assert.equal(
    notificationScript({ title: 'T', body: 'B', subtitle: '', sound: '' }),
    'display notification "B" with title "T"',
  )
})

test('every event kind has a stable system tone', () => {
  assert.deepEqual(Object.keys(TONES).sort(), ['approval', 'error', 'finish', 'question', 'test'])
  assert.equal(TONES.approval, 'Glass')
  assert.equal(TONES.question, 'Ping')
  assert.equal(TONES.finish, 'Tink')
  assert.equal(TONES.error, 'Basso')
})