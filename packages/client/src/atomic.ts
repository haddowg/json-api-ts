/**
 * The Atomic Operations transaction builder (CONTEXT.md "Atomic — typed transaction builder,
 * type-in-object"; ADR 0001). `client.atomic(tx => { … })` records a batch of operations and
 * posts them all-or-nothing to the server's `/operations` endpoint (the atomic ext media type),
 * returning the positional, materialised results.
 *
 * The `tx` recorder is NOT type-scoped (one builder spans every type), so each op carries its
 * own `type` discriminant:
 *
 * - `tx.create({ type, …flatFields })` -> an `add` op; returns a handle that DOUBLES AS a
 *   `lid`-bearing relationship ref (`{ type, lid }`) so a just-created resource wires into a
 *   later op without a server-assigned id;
 * - `tx.update({ type, id, …flatFields })` -> an `update` op (a `ref` to the existing resource);
 * - `tx.delete({ type, id })` -> a `remove` op.
 *
 * Each create gets a deterministic `lid` from its op index (`atomic-<index>`), so the cross-op
 * reference is stable and human-readable. The flat->envelope serialisation reuses the same
 * {@link toDocument} the standalone writes use, so an atomic create body is identical to a
 * `POST /{type}` body (minus the swap of a server `id` for the generated `lid`).
 */
import type { ApiDescriptor } from './descriptor'
import { JsonApiError } from './errors'
import { materialise, type MaterialiseContext } from './materialise'
import { execute, type JsonApiContext, type JsonApiRequest } from './request'
import { toDocument, withRemappedAtomicPaths } from './serialize-write'
import type { LocalIdentifier, ResourceIdentifier } from './types'
import { ATOMIC_MEDIA_TYPE } from './types'

/**
 * A reference to a resource for an `update`/`remove` op: a bare identifier (or a materialised
 * resource — its `{type,id}` extracted), OR a `{ type, lid }` local identifier targeting a
 * resource CREATED EARLIER IN THE SAME BATCH (e.g. a `tx.create` handle), so an op can update
 * or remove a just-created resource that has no server id yet (per the JSON:API atomic ext,
 * `ref` may carry `lid` instead of `id`).
 */
export type AtomicRef =
  | ResourceIdentifier
  | { type: string; id: string }
  | LocalIdentifier
  | { type: string; lid: string }

/** Flat create input: a `type` discriminant plus the resource's flat attributes/relations (relation slots may reference a prior `tx.create` handle). */
export interface AtomicCreateInput {
  type: string
  id?: string
  [field: string]: unknown
}

/**
 * Flat update input: a `type` discriminant + the target's identity (`id`, OR a `lid` for a
 * resource created earlier in the same batch) plus the flat attributes/relations to patch.
 */
export type AtomicUpdateInput =
  | ({ type: string; id: string; lid?: never } & Record<string, unknown>)
  | ({ type: string; lid: string; id?: never } & Record<string, unknown>)

/**
 * The handle a {@link AtomicRecorder.create} returns. It is a `lid`-bearing relationship ref
 * (`{ type, lid }`) — pass it (or spread it) into a later op's relation slot to wire the
 * just-created resource without a server id. `opIndex` is its position in the batch (the
 * created resource's positional result).
 */
export interface AtomicCreateHandle extends LocalIdentifier {
  readonly opIndex: number
}

/** A single recorded atomic operation, in wire shape (`op` + `ref`/`data`). */
interface AtomicOperation {
  op: 'add' | 'update' | 'remove'
  ref?: { type: string; id?: string; lid?: string }
  data?: unknown
}

/** The identity of an op's target resource: a server `id` or a same-batch `lid`. */
type AtomicIdentity = { id: string } | { lid: string }

/** The recorder handed to the `client.atomic` callback; each method appends an op and returns its handle/void. */
export interface AtomicRecorder {
  create(input: AtomicCreateInput): AtomicCreateHandle
  update(input: AtomicUpdateInput): void
  delete(ref: AtomicRef): void
}

/** One positional result of an atomic batch: the materialised `data` (a resource/`null`) plus any op `meta`. */
export interface AtomicResult {
  data: unknown
  meta?: Record<string, unknown>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The deterministic local id for the create at `opIndex` (stable + human-readable). */
const lidFor = (opIndex: number): string => `atomic-${opIndex}`

/**
 * Run an atomic transaction. Invokes `build` with a recorder, collecting the operations, then
 * posts `{ "atomic:operations": [...] }` to the atomic endpoint with the ext media type as both
 * `Content-Type` and `Accept`. The server's `{ "atomic:results": [...] }` is parsed positionally
 * — each result's `data` materialised the same as a read — and returned in op order. A thrown
 * {@link JsonApiError} has each error's pointer remapped to `(opIndex, flatPath)` (the failing
 * op's type drives the flat-path inversion) before it propagates.
 */
export async function runAtomic(
  request: JsonApiContext,
  materialiseCtx: MaterialiseContext,
  descriptor: ApiDescriptor,
  path: string,
  build: (tx: AtomicRecorder) => void,
): Promise<AtomicResult[]> {
  const operations: AtomicOperation[] = []
  /** The wire type of each op, by index — drives the error-pointer remap. */
  const typeByOp: string[] = []

  const recorder: AtomicRecorder = {
    create(input) {
      const opIndex = operations.length
      const lid = lidFor(opIndex)
      const data = atomicResourceData(descriptor, input, { lid })
      operations.push({ op: 'add', data })
      typeByOp.push(input.type)
      return { type: input.type, lid, opIndex }
    },
    update(input) {
      const identity: AtomicIdentity =
        input.id !== undefined ? { id: input.id } : { lid: input.lid }
      const data = atomicResourceData(descriptor, input, identity)
      operations.push({ op: 'update', ref: { type: input.type, ...identity }, data })
      typeByOp.push(input.type)
    },
    delete(ref) {
      const { type, identity } = toRef(ref)
      operations.push({ op: 'remove', ref: { type, ...identity } })
      typeByOp.push(type)
    },
  }

  build(recorder)

  const req: JsonApiRequest = {
    method: 'POST',
    path,
    body: { 'atomic:operations': operations },
    contentType: ATOMIC_MEDIA_TYPE,
    accept: ATOMIC_MEDIA_TYPE,
  }

  let doc
  try {
    doc = await execute(request, req)
  } catch (error) {
    if (error instanceof JsonApiError) {
      throw withRemappedAtomicPaths(error, descriptor, (opIndex) => typeByOp[opIndex])
    }
    throw error
  }

  return parseResults(doc as { ['atomic:results']?: unknown } | undefined, materialiseCtx)
}

/**
 * Build the resource `data` for an `add`/`update` op from flat input via {@link toDocument}
 * (so attributes/relationships route identically to a standalone write), then carry the op's
 * identity onto the resource: a server `id` (a create's server-assigned id is omitted; an
 * update by id keeps it) or a same-batch `lid` (a create's generated lid, or an update/remove
 * targeting an earlier op's resource).
 */
function atomicResourceData(
  descriptor: ApiDescriptor,
  input: AtomicCreateInput | AtomicUpdateInput,
  identity: AtomicIdentity,
): Record<string, unknown> {
  // Strip the identity keys before routing — `lid` is not an attribute, and `id` (when present
  // as a flat field) is carried via the identity, not the body. The identity is applied below.
  const { id: _id, lid: _lid, ...fields } = input as Record<string, unknown>
  const { data } = toDocument(
    descriptor,
    input.type,
    fields,
    'id' in identity ? { id: identity.id } : undefined,
  )
  const out: Record<string, unknown> = { ...data }
  if ('lid' in identity) {
    // A lid-targeted op rides a local id, never a server id.
    delete out['id']
    out['lid'] = identity.lid
  }
  return out
}

/**
 * Coerce a remove ref (an identifier, a materialised resource, or a same-batch `{type,lid}`
 * handle) to `{ type, identity }` — `identity` an `id` or a `lid`; throws if neither is present.
 */
function toRef(ref: AtomicRef): { type: string; identity: AtomicIdentity } {
  if (!isObject(ref)) {
    throw new TypeError('atomic delete requires an identifier `{ type, id }` or `{ type, lid }`')
  }
  const { type, id, lid } = ref as { type?: unknown; id?: unknown; lid?: unknown }
  if (typeof type !== 'string') {
    throw new TypeError('atomic delete requires a `type`')
  }
  if (typeof id === 'string') {
    return { type, identity: { id } }
  }
  if (typeof lid === 'string') {
    return { type, identity: { lid } }
  }
  throw new TypeError('atomic delete requires an `id` or a `lid`')
}

/** Parse `{ "atomic:results": [...] }` positionally, materialising each result's `data`. An absent results array (an all-`204` batch) yields `[]`. */
function parseResults(
  doc: { ['atomic:results']?: unknown } | undefined,
  ctx: MaterialiseContext,
): AtomicResult[] {
  const results = doc?.['atomic:results']
  if (!Array.isArray(results)) {
    return []
  }
  return results.map((result) => {
    const entry = isObject(result) ? result : {}
    const data = entry['data'] === undefined ? undefined : materialise({ data: entry['data'] }, ctx)
    const out: AtomicResult = { data }
    if (isObject(entry['meta'])) {
      out.meta = entry['meta']
    }
    return out
  })
}
