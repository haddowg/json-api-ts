#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { check, generate, type CodegenConfig } from './index'

export const USAGE =
  'Usage: json-api-codegen --input <url|file> --output <file> [--server <name>] [--schemas <url|file>] [--check]'

/**
 * Thin CLI wrapper. Real arg parsing + `japi.config.ts` discovery land with the
 * generator itself; this stub establishes the bin entry and the shape of invocation.
 * `--check` is a boolean flag (drift gate) with no value.
 */
export function parseArgs(argv: string[]): Partial<CodegenConfig> {
  const config: Partial<CodegenConfig> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') {
      config.check = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined) {
      continue
    }
    if (arg === '--input') {
      config.input = next
      i++
    } else if (arg === '--output') {
      config.output = next
      i++
    } else if (arg === '--server') {
      config.server = next
      i++
    } else if (arg === '--schemas') {
      config.schemas = next
      i++
    }
  }
  return config
}

export async function run(argv: string[]): Promise<number> {
  const config = parseArgs(argv)
  if (!config.input || !config.output) {
    console.error(USAGE)
    return 1
  }
  if (config.check) {
    const result = await check(config as CodegenConfig)
    for (const { path, upToDate } of result.artifacts) {
      console.error(`${upToDate ? 'ok  ' : 'DRIFT'} ${path}`)
    }
    if (!result.ok) {
      console.error(
        'Generated client is out of date with the source spec. Regenerate (drop --check) and commit the result.',
      )
      return 1
    }
    return 0
  }
  await generate(config as CodegenConfig)
  return 0
}

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2))
}

// Only run when invoked as the bin, not when imported (e.g. by tests).
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
