import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_DICTIONARIES, fmt, texts } from '../lib/messages.js'

test('fmt fills named placeholders and leaves unknown ones alone', () => {
  assert.equal(fmt('a {b} c', { b: 1 }), 'a 1 c')
  assert.equal(fmt('a {b} c', {}), 'a {b} c')
  assert.equal(fmt('{a}{a}', { a: 'x' }), 'xx')
  assert.equal(fmt('plain'), 'plain')
})

test('both languages expose the same message keys', () => {
  const zh = Object.keys(texts('zh')).sort()
  const en = Object.keys(texts('en')).sort()
  assert.deepEqual(en, zh)
})

test('every message is non-empty in both languages', () => {
  for (const language of ['zh', 'en']) {
    for (const [key, value] of Object.entries(texts(language))) {
      assert.equal(typeof value, 'string', `${language}.${key} must be a string`)
      assert.ok(value.length > 0, `${language}.${key} is empty`)
    }
  }
})

test('client dictionaries stay aligned across languages', () => {
  const zh = Object.keys(CLIENT_DICTIONARIES.zh).sort()
  const en = Object.keys(CLIENT_DICTIONARIES.en).sort()
  assert.deepEqual(en, zh)
  for (const language of ['zh', 'en']) {
    for (const [key, value] of Object.entries(CLIENT_DICTIONARIES[language])) {
      assert.ok(typeof value === 'string' && value.length > 0, `${language}.${key}`)
    }
  }
})

test('non-Chinese languages fall back to English', () => {
  assert.equal(texts('fr').statusNever, texts('en').statusNever)
  assert.equal(texts('ja').statusNever, texts('en').statusNever)
})