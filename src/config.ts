import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config, EmoteMapping, EmotesConfig } from './types'
import { DEFAULT_WIDGET_THEME, sanitizeWidgetTheme } from './theme'

export class PathResolver {
  readonly localEmotesDir: string
  readonly globalEmotesDir: string
  readonly defaultEmotesDir: string

  constructor(extDir: string) {
    this.localEmotesDir = join(
      process.cwd(),
      '.pi',
      'extensions',
      'pi-emote',
      'emotes',
    )
    const home = homedir()
    this.globalEmotesDir = home
      ? join(home, '.pi', 'agent', 'extensions', 'pi-emote', 'emotes')
      : ''
    this.defaultEmotesDir = join(extDir, 'emotes')
  }

  getSearchPaths(): string[] {
    return [
      this.localEmotesDir,
      this.globalEmotesDir,
      this.defaultEmotesDir,
    ].filter(Boolean)
  }

  getConfigPaths(): string[] {
    return this.getSearchPaths().map((p) => join(p, 'config.json'))
  }

  getCharacterDir(character: string): string | null {
    if (!character) return null
    for (const p of this.getSearchPaths()) {
      const charPath = join(p, character)
      if (existsSync(charPath)) return charPath
    }
    return null
  }

  getAllCharacters(): string[] {
    const chars = new Set<string>()
    for (const p of this.getSearchPaths()) {
      if (existsSync(p)) {
        try {
          const dirs = readdirSync(p, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
          for (const d of dirs) chars.add(d)
        } catch (e) {}
      }
    }
    return Array.from(chars).sort()
  }
}

export function loadConfig(resolver: PathResolver): Config {
  const defaults: Config = {
    enabled: true,
    size: 8,
    character: 'pi',
    hideBelow: 40,
    terminals: [
      { match: 'zellij', render: 'ascii' },
      { match: 'tmux', render: 'auto' },
      { match: 'screen', render: 'ascii' },
      { match: 'wezterm', render: 'iterm2' },
      { match: 'ghostty', render: 'kitty' },
      { match: 'warpterminal', render: 'kitty' },
    ],
    holdDuration: { hi: 2000, success: 1200, failure: 1200 },
    blinkInterval: [3000, 6000],
    talkTickMs: 120,
    cycleMs: 500,
    idle: { default: 'idle.png', blink: 'idle_blink.png' },
    talk: {
      weights: {
        'talk_close.png': 0.15,
        'talk_small.png': 0.3,
        'talk_mid.png': 0.35,
        'talk_wide.png': 0.2,
      },
    },
    theme: { ...DEFAULT_WIDGET_THEME },
  }

  for (const configPath of resolver.getConfigPaths()) {
    if (existsSync(configPath)) {
      try {
        const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
        const merged = { ...defaults, ...userConfig }
        merged.theme = sanitizeWidgetTheme(merged.theme)
        return merged
      } catch (e) {}
    }
  }

  return { ...defaults, theme: { ...DEFAULT_WIDGET_THEME } }
}

function resolveTargetPath(resolver: PathResolver): string {
  const paths = resolver.getConfigPaths()
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return paths[paths.length - 1] // Default to extension dir
}

/** Why a save wrote nothing, for a caller that has to tell the user. */
export type SaveFailureReason = 'unreadable' | 'unwritable'

/** Whether a save landed, and why it did not when it could not. */
export type SaveOutcome =
  | { saved: true }
  | { saved: false; reason: SaveFailureReason }

/**
 * The config file's contents, or `undefined` when the file exists but cannot be
 * read. An unreadable file is not an empty one: merging a patch over `{}` would
 * discard the settings that are still on disk.
 */
function readConfigFile(targetPath: string): Partial<Config> | undefined {
  try {
    return JSON.parse(readFileSync(targetPath, 'utf-8'))
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : undefined
  }
}

/**
 * Merge a patch into the config file on disk, and nothing else.
 *
 * This process read its Config once at extension load, so writing that whole
 * object back reverts every key the user has edited on disk since -- which is how
 * a hand-set `size` reverted itself after a `/emote switch`. A save carries only
 * the keys the command actually changed, and declines to write when the file it
 * would merge into cannot be read.
 */
function mergeAndWrite(
  resolver: PathResolver,
  patch: (onDisk: Partial<Config>) => Partial<Config>,
): SaveOutcome {
  const targetPath = resolveTargetPath(resolver)
  const onDisk = readConfigFile(targetPath)
  if (onDisk === undefined) return { saved: false, reason: 'unreadable' }

  try {
    writeFileSync(
      targetPath,
      JSON.stringify({ ...onDisk, ...patch(onDisk) }, null, 2),
    )
  } catch (e) {
    return { saved: false, reason: 'unwritable' }
  }

  return { saved: true }
}

/** Set the character used when no model-specific character applies. */
export function setCharacter(
  resolver: PathResolver,
  character: string,
): SaveOutcome {
  return mergeAndWrite(resolver, () => ({ character }))
}

/** Point one model at a character, leaving the other models' choices alone. */
export function setModelCharacter(
  resolver: PathResolver,
  model: string,
  character: string,
): SaveOutcome {
  return mergeAndWrite(resolver, (onDisk) => ({
    modelCharacters: { ...onDisk.modelCharacters, [model]: character },
  }))
}

export function loadEmotesConfig(
  resolver: PathResolver,
  character: string,
): EmotesConfig {
  const characterDir = resolver.getCharacterDir(character)
  if (!characterDir) return {}

  const emotesConfigPath = join(characterDir, 'emotes.json')
  if (existsSync(emotesConfigPath)) {
    try {
      return JSON.parse(readFileSync(emotesConfigPath, 'utf-8'))
    } catch (e) {}
  }
  return {}
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

export function resolveEmoteSet(
  modelId: string,
  thinkingLevel: string,
  emotes: EmoteMapping[],
): string {
  let matched: string | null = null

  for (const entry of emotes) {
    const modelPattern = entry.model ?? '*'
    const thinkingPattern = entry['thinking-level'] ?? '*'
    if (
      globToRegex(modelPattern).test(modelId) &&
      globToRegex(thinkingPattern).test(thinkingLevel)
    ) {
      matched = entry['emote-set']
    }
  }

  return matched ?? 'default'
}

export function getEffectiveCharacter(
  resolver: PathResolver,
  config: Config,
  modelName?: string,
  thinkingLevel?: string,
): string {
  if (config.emotes && config.emotes.length > 0) {
    const setName = resolveEmoteSet(
      modelName ?? '',
      thinkingLevel ?? '',
      config.emotes,
    )
    if (resolver.getCharacterDir(setName)) {
      return setName
    }
  }

  if (modelName && config.modelCharacters) {
    // Try exact match first
    if (config.modelCharacters[modelName]) {
      const preferred = config.modelCharacters[modelName]
      if (resolver.getCharacterDir(preferred)) {
        return preferred
      }
    }

    // Try glob match
    for (const [pattern, character] of Object.entries(config.modelCharacters)) {
      try {
        const regex = globToRegex(pattern)
        if (regex.test(modelName)) {
          if (resolver.getCharacterDir(character)) {
            return character
          }
        }
      } catch (e) {
        // Skip invalid regex
      }
    }
  }
  return config.character
}
