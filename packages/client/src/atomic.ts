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
import type { AtomicResultOf, CreateInput, TypeName, UpdateInput } from './result-types'
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

/**
 * Flat create input for type `T`: the `type` discriminant plus the type's flat create
 * attributes/relation slots (reusing {@link CreateInput}; relation slots may reference a prior
 * `tx.create` handle). `D`/`W` thread the descriptor + write-attribute map for precise fields;
 * the loose defaults keep a codegen-less caller compiling.
 */
export type AtomicCreateInput<D extends ApiDescriptor, W, T extends TypeName<D>> = {
  type: T
} & CreateInput<D, W, T>

/**
 * Flat update input for type `T`: the `type` discriminant + the target's identity (`id`, OR a
 * `lid` for a resource created earlier in the same batch) plus the type's flat update
 * attributes/relation slots (reusing {@link UpdateInput}).
 */
export type AtomicUpdateInput<D extends ApiDescriptor, W, T extends TypeName<D>> =
  | ({ type: T; id: string; lid?: never } & UpdateInput<D, W, T>)
  | ({ type: T; lid: string; id?: never } & UpdateInput<D, W, T>)

/**
 * The handle a {@link AtomicRecorder.create} returns. It is a `lid`-bearing relationship ref
 * (`{ type, lid }`) — pass it (or spread it) into a later op's relation slot to wire the
 * just-created resource without a server id. It also carries its op `kind` (`'create'`) and its
 * `opIndex` (its position in the batch, the created resource's positional result) so the typed
 * result tuple can map it back to the right positional result.
 */
export interface AtomicCreateHandle<T extends string = string> extends LocalIdentifier {
  readonly type: T
  readonly kind: 'create'
  readonly opIndex: number
}

/**
 * The handle a {@link AtomicRecorder.update} returns: its type discriminant `T`, its op `kind`
 * (`'update'`) and its `opIndex`. Returned (alongside the create handle) from the callback so its
 * positional result is typed as the materialised resource of `T`.
 */
export interface AtomicUpdateHandle<T extends string = string> {
  readonly type: T
  readonly kind: 'update'
  readonly opIndex: number
}

/**
 * The handle a {@link AtomicRecorder.delete} returns: its op `kind` (`'delete'`) and its
 * `opIndex`. A delete carries no data, so its positional result is `undefined`.
 */
export interface AtomicDeleteHandle {
  readonly kind: 'delete'
  readonly opIndex: number
}

/**
 * Any handle a recorder method returns — the element type of the callback's result tuple, used
 * as the inference constraint for the typed-tuple `atomic` form. The discriminant is left open
 * (`string`, NOT `TypeName<D>`) DELIBERATELY, so the type is descriptor-agnostic: a tighter
 * `TypeName<D>` constraint would flow the full type union into each element's contextual type
 * during array-literal inference, widening a `tx.create({ type: 'albums' })` handle's `T` back to
 * the whole union — losing the per-op narrowing. The recorder methods already guarantee each `T`
 * is a real `TypeName<D>`, so the open constraint is sound; `AtomicResultOf` re-infers the precise
 * `T` per element (guarded by `TypeName<D>` there).
 */
export type AtomicHandle =
  | AtomicCreateHandle<string>
  | AtomicUpdateHandle<string>
  | AtomicDeleteHandle

/** A single recorded atomic operation, in wire shape (`op` + `ref`/`data`). */
interface AtomicOperation {
  op: 'add' | 'update' | 'remove'
  ref?: { type: string; id?: string; lid?: string }
  data?: unknown
}

/** The identity of an op's target resource: a server `id` or a same-batch `lid`. */
type AtomicIdentity = { id: string } | { lid: string }

/**
 * The recorder handed to the `client.atomic` callback. Each method appends an op (preserving
 * order) and returns a handle carrying the op's discriminant `T`, `kind`, and `opIndex`. The
 * methods are generic over `T` (inferred from the input's `type`), so a create/update is typed
 * by the type's write-input ({@link CreateInput}/{@link UpdateInput}) and its handle resolves to
 * the materialised resource of `T`. `create` still returns a usable `{ type, lid }` ref so a
 * just-created resource wires into a later op without a server id.
 */
export interface AtomicRecorder<D extends ApiDescriptor, W> {
  create<T extends TypeName<D>>(input: AtomicCreateInput<D, W, T>): AtomicCreateHandle<T>
  update<T extends TypeName<D>>(input: AtomicUpdateInput<D, W, T>): AtomicUpdateHandle<T>
  delete(ref: AtomicRef): AtomicDeleteHandle
}

/** One positional result of an atomic batch: the materialised `data` (a resource/`null`) plus any op `meta`. */
export interface AtomicResult<Data = unknown> {
  data: Data
  meta?: Record<string, unknown>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The deterministic local id for the create at `opIndex` (stable + human-readable). */
const lidFor = (opIndex: number): string => `atomic-${opIndex}`

/**
 * The typed result tuple for a callback that returns a tuple of handles `Ops`: each returned
 * handle maps (by {@link AtomicResultOf}) to its materialised positional result — a create/update
 * handle to the `AtomicResult` of its type, a delete handle to `undefined`. The mapping is
 * positional in the RETURNED order (sound regardless of subset/reorder, since the runtime resolves
 * each handle by its `opIndex`).
 */
export type AtomicResults<D extends ApiDescriptor, A, Ops extends readonly AtomicHandle[]> = {
  -readonly [K in keyof Ops]: AtomicResultOf<D, A, Ops[K]>
}

/**
 * Run an atomic transaction. Invokes `build` with a recorder, collecting the operations (always
 * via the recorder's side effect, preserving op order), then posts `{ "atomic:operations": [...] }`
 * to the atomic endpoint with the ext media type as both `Content-Type` and `Accept`. The server's
 * `{ "atomic:results": [...] }` is parsed positionally — each result's `data` materialised the same
 * as a read.
 *
 * The return shape depends on what `build` returns:
 *
 * - returns a tuple of handles -> a per-op POSITIONALLY-TYPED tuple: each returned handle is
 *   resolved to its result BY ITS `opIndex` (`results[handle.opIndex]`), so the tuple is sound
 *   regardless of the order/subset the callback returns the handles in (a delete handle resolves
 *   to `undefined`);
 * - returns void/nothing -> the loose, ordered `AtomicResult[]` (backward-compatible).
 *
 * A thrown {@link JsonApiError} has each error's pointer remapped to `(opIndex, flatPath)` (the
 * failing op's type drives the flat-path inversion) before it propagates.
 */
export function runAtomic<D extends ApiDescriptor, A, W, const Ops>(
  request: JsonApiContext,
  materialiseCtx: MaterialiseContext,
  descriptor: D,
  path: string,
  build: (tx: AtomicRecorder<D, W>) => Ops,
): Promise<Ops extends readonly AtomicHandle[] ? AtomicResults<D, A, Ops> : AtomicResult[]>
export async function runAtomic(
  request: JsonApiContext,
  materialiseCtx: MaterialiseContext,
  descriptor: ApiDescriptor,
  path: string,
  build: (tx: AtomicRecorder<ApiDescriptor, unknown>) => readonly AtomicHandle[] | void,
): Promise<AtomicResult[] | readonly (AtomicResult | undefined)[]> {
  const operations: AtomicOperation[] = []
  /** The wire type of each op, by index — drives the error-pointer remap. */
  const typeByOp: string[] = []

  const recorder: AtomicRecorder<ApiDescriptor, unknown> = {
    create(input) {
      const opIndex = operations.length
      const lid = lidFor(opIndex)
      const data = atomicResourceData(descriptor, input, { lid })
      operations.push({ op: 'add', data })
      typeByOp.push(input.type)
      return { type: input.type, lid, kind: 'create', opIndex }
    },
    update(input) {
      const opIndex = operations.length
      const identity: AtomicIdentity =
        input.id !== undefined ? { id: input.id } : { lid: input.lid }
      const data = atomicResourceData(descriptor, input, identity)
      operations.push({ op: 'update', ref: { type: input.type, ...identity }, data })
      typeByOp.push(input.type)
      return { type: input.type, kind: 'update', opIndex }
    },
    delete(ref) {
      const opIndex = operations.length
      const { type, identity } = toRef(ref)
      operations.push({ op: 'remove', ref: { type, ...identity } })
      typeByOp.push(type)
      return { kind: 'delete', opIndex }
    },
  }

  // The callback always drives the recorder side effect (collecting ops in order); its RETURN
  // VALUE — when it's a tuple of handles — selects the typed positional result per handle.
  const returned = build(recorder)

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

  const results = parseResults(doc as { ['atomic:results']?: unknown } | undefined, materialiseCtx)

  // Loose form: the callback returned nothing, or not an all-handles array -> the ordered results
  // array (backward-compatible). The all-handles guard keeps the runtime in step with the type
  // predicate (`Ops extends readonly AtomicHandle[]`): a stray non-handle element resolves to the
  // loose AtomicResult[] the type promises rather than a row of undefined.
  const isHandleTuple =
    Array.isArray(returned) &&
    returned.every((h) => h !== null && typeof h === 'object' && 'opIndex' in h)
  if (!isHandleTuple) {
    return results
  }
  // Typed-tuple form: resolve each RETURNED handle by its `opIndex` (a delete -> undefined), so
  // the tuple is sound regardless of the order/subset of handles returned. (A server returning no
  // `atomic:results` for an op yields undefined; the reference bundle always returns the created/
  // updated resource, so create/update results are typed present.)
  return returned.map((handle) => (handle.kind === 'delete' ? undefined : results[handle.opIndex]))
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
  input: { type: string; [field: string]: unknown },
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
