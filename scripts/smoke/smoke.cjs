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

console.log('[cjs] @haddowg/json-api-client, /ajv, -query, -angular and -mcp resolved from dist OK')
