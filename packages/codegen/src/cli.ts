#!/usr/bin/env node
import { generate, type CodegenConfig } from './index'

/**
 * Thin CLI wrapper. Real arg parsing + `japi.config.ts` discovery land with the
 * generator itself; this stub establishes the bin entry and the shape of invocation.
 */
function parseArgs(argv: string[]): Partial<CodegenConfig> {
  const config: Partial<CodegenConfig> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
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

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2))
  if (!config.input || !config.output) {
    console.error(
      'Usage: json-api-codegen --input <url|file> --output <file> [--server <name>] [--schemas <url|file>]',
    )
    process.exitCode = 1
    return
  }
  await generate(config as CodegenConfig)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
