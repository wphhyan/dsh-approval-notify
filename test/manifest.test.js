import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('declares a bundle patch and a web client half', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(fs.existsSync(path.join(root, 'cordis.patch.yml')))
})

test('ships every runtime file the manifest references', () => {
  const required = [
    'index.js',
    'client.js',
    'lib/notify.js',
    'lib/state.js',
    'lib/system.js',
    'lib/messages.js',
    'lib/finish.js',
    'lib/session.js',
    'helper/dsh-notify.m',
    'locale/zh.json',
    'locale/en.json',
    'icon.svg',
    'README.md',
    'README.en.md',
    'LICENSE',
  ]
  for (const file of required) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`)
  }
  assert.ok(manifest.files.includes('helper'), 'files must ship the helper app')
  assert.ok(manifest.files.includes('README.en.md'), 'files must ship the English README')
})

test('keeps the icon inside the plugin icon limits', () => {
  const size = fs.statSync(path.join(root, 'icon.svg')).size
  assert.ok(size > 0 && size < 256 * 1024)
})

test('ships the helper binary as executable', () => {
  const binary = path.join(root, 'helper', 'DSHNotify.app', 'Contents', 'MacOS', 'dsh-notify')
  fs.accessSync(binary, fs.constants.X_OK)
})

test('locales carry a title and a factual description', () => {
  for (const locale of ['zh', 'en']) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${locale}.json`), 'utf8')).meta
    assert.ok(meta.title.length > 0, `${locale} title is empty`)
    assert.ok(meta.description.length > 40, `${locale} description is too short`)
  }
})

test('the patch row names this package and one unique id', () => {
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*approval-notify/)
  assert.match(patch, new RegExp(`name:\\s*['"]?${manifest.name}`))
  assert.equal((patch.match(/id:\s*approval-notify/g) ?? []).length, 1)
})