// ESM resolution smoke for the built dist. `node` resolves these bare specifiers
// through each package's `exports` map under the `import` condition (-> dist/*.mjs),
// so this proves the ESM build + the `./ajv` sub-path export load and run as published.
import assert from 'node:assert/strict'

import { createClient, materialise, serializeQuery } from '@haddowg/json-api-client'
import { createAjvValidator } from '@haddowg/json-api-client/ajv'
import { createQueryApi, keyFor, listQueryOptions } from '@haddowg/json-api-query'

for (const [name, fn] of [
  ['createClient', createClient],
  ['materialise', materialise],
  ['serializeQuery', serializeQuery],
  ['createAjvValidator', createAjvValidator],
  ['createQueryApi', createQueryApi],
  ['keyFor', keyFor],
  ['listQueryOptions', listQueryOptions],
]) {
  assert.equal(typeof fn, 'function', `[esm] expected ${name} to be a function`)
}

console.log('[esm] @haddowg/json-api-client, /ajv, and -query resolved from dist OK')
