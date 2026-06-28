/**
 * @haddowg/json-api-client — the generic, framework-agnostic runtime.
 *
 * Parameterised by the generated descriptor (see ./descriptor.ts and ADR 0001). The
 * pieces below are the stable seams already designed in CONTEXT.md; the materialiser,
 * the fluent client builder, and the normalized index land on top of them.
 *
 * TODO (build order):
 *  - createClient(descriptor, options): the fluent, id-scoped builder
 *  - materialise(): compound-doc -> hydrated graph (flatten + $-accessors + per-edge
 *    views + augmented arrays)
 *  - normalized index (optional): type:id merge across responses
 */
export * from './client'
export * from './descriptor'
export * from './errors'
export * from './materialise'
export * from './request'
export * from './result-types'
export * from './transport'
export * from './types'
