import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The state module resolves the profile directory on every call, so a throwaway
// profile keeps the tests off the real plugin data.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-approval-notify-test-'))
process.env.DSH_PROFILE_DIR = directory

const { pluginDataDirectory, readState, statePath, writeState } = await import('../lib/state.js')

test('reads an empty document when nothing is stored', () => {
  const state = readState()
  assert.equal(state.version, 2)
  assert.equal(state.approvals, 0)
  assert.equal(state.questions, 0)
  assert.equal(state.finishes, 0)
  assert.equal(state.errors, 0)
  assert.equal(state.lastKind, '')
})

test('merges and normalizes counters and the last event', () => {
  writeState({ approvals: 2, finishes: -5, errors: '3', lastKind: '完成', lastLabel: 'demo' })
  const state = readState()
  assert.equal(state.approvals, 2)
  assert.equal(state.finishes, 0)
  assert.equal(state.errors, 3)
  assert.equal(state.lastKind, '完成')
  assert.equal(state.lastLabel, 'demo')
  assert.equal(state.version, 2)
})

test('survives a corrupt document', () => {
  fs.writeFileSync(statePath(), '{not json')
  const state = readState()
  assert.equal(state.approvals, 0)
})

test('lives under the profile plugin-data directory', () => {
  assert.ok(pluginDataDirectory().startsWith(directory))
  assert.ok(statePath().endsWith(path.join('plugin-data', 'dsh-approval-notify', 'state.json')))
})

test.after(() => fs.rmSync(directory, { recursive: true, force: true }))