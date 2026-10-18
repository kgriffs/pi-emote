import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  PathResolver,
  loadConfig,
  setCharacter,
  setModelCharacter,
} from './config'

/**
 * A throwaway workspace whose project-level config is the file under test.
 *
 * `PathResolver` reads `process.cwd()` and `os.homedir()` at construction, so both
 * are redirected here first: nothing in these tests may reach the developer's own
 * `~/.pi/agent/extensions/pi-emote/emotes/config.json`.
 */
const workspaces: string[] = []

function workspace(config?: object) {
  const root = mkdtempSync(join(tmpdir(), 'pi-emote-config-'))
  workspaces.push(root)
  const emotesDir = join(root, '.pi', 'extensions', 'pi-emote', 'emotes')
  mkdirSync(emotesDir, { recursive: true })
  const configPath = join(emotesDir, 'config.json')
  if (config) writeFileSync(configPath, JSON.stringify(config, null, 2))

  process.env.HOME = root
  process.chdir(root)

  return { root, configPath, resolver: new PathResolver(join(root, 'pkg')) }
}

function read(path: string) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

/** What the user does while a session is already running: edit the file by hand. */
function setSize(path: string, size: number) {
  writeFileSync(path, JSON.stringify({ ...read(path), size }, null, 2))
}

const cwd = process.cwd()
const home = process.env.HOME
after(() => {
  process.chdir(cwd)
  process.env.HOME = home
  for (const root of workspaces) rmSync(root, { recursive: true, force: true })
})

describe('setCharacter', () => {
  it('keeps a size the user edited by hand after the session loaded', () => {
    const { configPath, resolver } = workspace({ size: 14, character: 'pi' })

    const session = loadConfig(resolver) // session start: this process now holds 14
    assert.equal(session.size, 14)
    setSize(configPath, 8) // user sets 8 while that session is still running

    assert.deepEqual(setCharacter(resolver, 'bit'), { saved: true })

    assert.equal(read(configPath).size, 8, 'hand-set size survived the switch')
    assert.equal(read(configPath).character, 'bit')
    assert.equal(session.size, 14, 'the running session is left alone')
  })

  it('preserves every other key the file already had', () => {
    const { configPath, resolver } = workspace({
      enabled: true,
      size: 14,
      character: 'pi',
      hideBelow: 40,
      theme: { 'token-info': 'dim' },
    })
    const before = read(configPath)

    setCharacter(resolver, 'bit')

    assert.deepEqual(read(configPath), { ...before, character: 'bit' })
  })

  it('writes to the config the session loaded from', () => {
    const { root, configPath, resolver } = workspace({ size: 14 })

    loadConfig(resolver)
    setCharacter(resolver, 'bit')

    assert.equal(read(configPath).character, 'bit')
    assert.equal(existsSync(join(root, 'pkg', 'emotes', 'config.json')), false)
  })

  it('creates the config when the user has none yet', () => {
    const { root, resolver } = workspace()
    mkdirSync(join(root, 'pkg', 'emotes'), { recursive: true })

    assert.deepEqual(setCharacter(resolver, 'bit'), { saved: true })

    assert.equal(
      read(join(root, 'pkg', 'emotes', 'config.json')).character,
      'bit',
    )
  })

  it('leaves an unreadable config alone rather than overwriting it', () => {
    const { configPath, resolver } = workspace()
    writeFileSync(configPath, '{ not json')
    const before = readFileSync(configPath, 'utf-8')

    assert.deepEqual(setCharacter(resolver, 'bit'), {
      saved: false,
      reason: 'unreadable',
    })

    assert.equal(readFileSync(configPath, 'utf-8'), before, 'file untouched')
  })

  it('reports an unwritable config instead of pretending to save', (t) => {
    const { configPath, resolver } = workspace({ character: 'pi' })
    const before = readFileSync(configPath, 'utf-8')
    chmodSync(configPath, 0o444)
    if (process.getuid?.() === 0) {
      t.skip('running as root, which ignores file permissions')
      return
    }

    assert.deepEqual(setCharacter(resolver, 'bit'), {
      saved: false,
      reason: 'unwritable',
    })

    assert.equal(readFileSync(configPath, 'utf-8'), before, 'file untouched')
  })
})

describe('setModelCharacter', () => {
  it('points one model at a character without disturbing the others', () => {
    const { configPath, resolver } = workspace({
      size: 14,
      modelCharacters: { gemini: 'pi' },
    })

    loadConfig(resolver)
    setSize(configPath, 8)

    assert.deepEqual(setModelCharacter(resolver, 'gpt', 'ascii'), {
      saved: true,
    })

    assert.equal(read(configPath).size, 8)
    assert.deepEqual(read(configPath).modelCharacters, {
      gemini: 'pi',
      gpt: 'ascii',
    })
  })

  it('reports an unreadable config the same way', () => {
    const { configPath, resolver } = workspace()
    writeFileSync(configPath, 'nope')

    assert.deepEqual(setModelCharacter(resolver, 'gpt', 'ascii'), {
      saved: false,
      reason: 'unreadable',
    })
  })
})
