// CJS resolution smoke for the built dist. `require` resolves these bare specifiers
// through each package's `exports` map under the `require` condition (-> dist/*.cjs),
// so this proves the CJS build + the `./ajv` sub-path export load and run as published.
const assert = require('node:assert/strict')
// Angular's packages are partially compiled; plain Node needs the JIT compiler to link them.
require('@angular/compiler')

const { createClient, materialise, serializeQuery } = require('@haddowg/json-api-client')
const { createAjvValidator } = require('@haddowg/json-api-client/ajv')
const { createJsonApiMcp, readActionSafety } = require('@haddowg/json-api-mcp')
const { createQueryApi, keyFor, listQueryOptions } = require('@haddowg/json-api-query')
const {
  httpClientTransport,
  jsonApiMutation,
  jsonApiResource,
  loadAll,
  provideJsonApiClient,
} = require('@haddowg/json-api-angular')

for (const [name, fn] of [
  ['createClient', createClient],
  ['materialise', materialise],
  ['serializeQuery', serializeQuery],
  ['createAjvValidator', createAjvValidator],
  ['createQueryApi', createQueryApi],
  ['keyFor', keyFor],
  ['listQueryOptions', listQueryOptions],
  ['httpClientTransport', httpClientTransport],
  ['provideJsonApiClient', provideJsonApiClient],
  ['jsonApiResource', jsonApiResource],
  ['jsonApiMutation', jsonApiMutation],
  ['loadAll', loadAll],
  ['createJsonApiMcp', createJsonApiMcp],
  ['readActionSafety', readActionSafety],
]) {
  assert.equal(typeof fn, 'function', `[cjs] expected ${name} to be a function`)
}

// The MCP runtime serves a committed model from CommonJS, with no codegen in its bundle.
const { readFileSync } = require('node:fs')
const mcpDist = require.resolve('@haddowg/json-api-mcp')
assert.ok(mcpDist.endsWith('.cjs'), `[cjs] expected the mcp runtime's CJS build, got ${mcpDist}`)
assert.doesNotMatch(readFileSync(mcpDist, 'utf8'), /json-api-codegen/)
const model = require('../../packages/mcp/test/generated/music-catalog.mcp.gen.json')
const mcp = createJsonApiMcp({
  model,
  transport: async () => ({
    status: 200,
    headers: {},
    body: '{"data":{"type":"albums","id":"1","attributes":{"title":"Help!"}}}',
  }),
})

;(async () => {
  const session = await mcp.forRequest({ context: undefined })
  const result = await session.callTool('albums_get', { id: '1' })
  assert.deepEqual(result.structuredContent, { data: { id: '1', type: 'albums', title: 'Help!' } })
  console.log(
    '[cjs] @haddowg/json-api-client, /ajv, -query, -angular and -mcp resolved from dist OK, and the mcp runtime served a committed model',
  )
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
