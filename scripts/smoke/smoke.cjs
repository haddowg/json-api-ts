// CJS resolution smoke for the built dist. `require` resolves these bare specifiers
// through each package's `exports` map under the `require` condition (-> dist/*.cjs),
// so this proves the CJS build + the `./ajv` sub-path export load and run as published.
const assert = require('node:assert/strict')

const { createClient, materialise, serializeQuery } = require('@haddowg/json-api-client')
const { createAjvValidator } = require('@haddowg/json-api-client/ajv')
const { createQueryApi, keyFor, listQueryOptions } = require('@haddowg/json-api-query')

for (const [name, fn] of [
  ['createClient', createClient],
  ['materialise', materialise],
  ['serializeQuery', serializeQuery],
  ['createAjvValidator', createAjvValidator],
  ['createQueryApi', createQueryApi],
  ['keyFor', keyFor],
  ['listQueryOptions', listQueryOptions],
]) {
  assert.equal(typeof fn, 'function', `[cjs] expected ${name} to be a function`)
}

console.log('[cjs] @haddowg/json-api-client, /ajv, and -query resolved from dist OK')
