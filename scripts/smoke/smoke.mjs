// ESM resolution smoke for the built dist. `node` resolves these bare specifiers
// through each package's `exports` map under the `import` condition (-> dist/*.mjs),
// so this proves the ESM build + the `./ajv` sub-path export load and run as published.
import assert from 'node:assert/strict'
// Angular's packages are partially compiled; plain Node needs the JIT compiler to link them.
import '@angular/compiler'

import { createClient, materialise, serializeQuery } from '@haddowg/json-api-client'
import { createAjvValidator } from '@haddowg/json-api-client/ajv'
import {
  httpClientTransport,
  jsonApiResource,
  loadAll,
  provideJsonApiClient,
} from '@haddowg/json-api-angular'
import { createQueryApi, keyFor, listQueryOptions } from '@haddowg/json-api-query'

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
  ['loadAll', loadAll],
]) {
  assert.equal(typeof fn, 'function', `[esm] expected ${name} to be a function`)
}

console.log('[esm] @haddowg/json-api-client, /ajv, -query and -angular resolved from dist OK')
