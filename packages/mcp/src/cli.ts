#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { writeMcpModel, type WriteModelOptions } from './generate'

export const USAGE =
  'Usage: json-api-mcp --input <url|file> --output <file> [--default-page-size <n>] [--check]'

/** Read the command line into generator options. */
export function parseArgs(argv: readonly string[]): Partial<WriteModelOptions> {
  const options: Partial<WriteModelOptions> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') {
      options.check = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined) {
      continue
    }
    if (arg === '--input') {
      options.input = next
      i++
    } else if (arg === '--output') {
      options.output = next
      i++
    } else if (arg === '--default-page-size') {
      options.defaultPageSize = Number(next)
      i++
    }
  }
  return options
}

/** Run the CLI; resolves to the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv)
  if (options.input === undefined || options.output === undefined) {
    console.error(USAGE)
    return 1
  }
  if (
    options.defaultPageSize !== undefined &&
    !(Number.isInteger(options.defaultPageSize) && options.defaultPageSize > 0)
  ) {
    console.error('--default-page-size takes a positive whole number')
    return 1
  }
  try {
    const result = await writeMcpModel(options as WriteModelOptions)
    if (options.check === true) {
      if (!result.upToDate) {
        console.error(
          `[json-api-mcp] ${result.path} is out of date with ${options.input}; run json-api-mcp without --check to regenerate it.`,
        )
        return 1
      }
      console.error(`ok   ${result.path}`)
      return 0
    }
    console.error(`[json-api-mcp] wrote ${result.path}`)
    return 0
  } catch (error) {
    console.error(`[json-api-mcp] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

// A package manager runs the bin through a symlink, so compare real paths.
const invoked = process.argv[1]
if (
  invoked !== undefined &&
  realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main(process.argv.slice(2))
}
