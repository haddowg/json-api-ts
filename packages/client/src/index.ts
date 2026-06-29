/**
 * @haddowg/json-api-client — the generic, framework-agnostic runtime.
 *
 * Parameterised by the generated descriptor (see ./descriptor.ts and ADR 0001):
 * createClient builds the fluent, id-scoped read/write surface; materialise turns a
 * compound document into the hydrated graph (flatten + $-accessors + per-edge views +
 * augmented arrays); errors/transport/serialize-write/validate/atomic are the seams it
 * composes. The optional TanStack binding + normalization live in @haddowg/json-api-query.
 */
export * from './atomic'
export * from './client'
export * from './descriptor'
export * from './errors'
export * from './materialise'
export * from './request'
export * from './result-types'
export * from './serialize-write'
export * from './transport'
export * from './types'
export * from './validate'
