import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionLabel } from '../lib/session.js'

test('uses the folder name with a short id suffix', () => {
  assert.equal(sessionLabel('abcdef123456', '/Users/me/projects/demo'), 'demo · abcd')
})

test('falls back to the id when the working directory is unknown', () => {
  assert.equal(sessionLabel('abcdef123456', undefined), 'abcdef123456')
  assert.equal(sessionLabel('abcdef123456', ''), 'abcdef123456')
})

test('two sessions in the same folder stay distinguishable', () => {
  const first = sessionLabel('aaaa1111', '/tmp/work')
  const second = sessionLabel('bbbb2222', '/tmp/work')
  assert.notEqual(first, second)
  assert.equal(first, 'work · aaaa')
  assert.equal(second, 'work · bbbb')
})
