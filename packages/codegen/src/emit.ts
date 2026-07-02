import {
  type ActionDescriptor,
  type ApiDescriptor,
  type AtomicDescriptor,
  HANDLE_RESERVED,
  type ResourceDescriptor,
} from '@haddowg/json-api-client'
import { buildAtomic } from './build-descriptor'
import type { OpenApiDocument, SchemaObject, SchemaOrBool } from './openapi'
import { deriveProvenance, provenanceLines, type Provenance } from './provenance'

const REF_PREFIX = '#/components/schemas/'
const JSON_API_MEDIA_TYPE = 'application/vnd.api+json'

/** A loose JSON:API document shape — the fallback an action body/result types as when its component can't be resolved. */
const LOOSE_DOCUMENT = 'Record<string, unknown>'

/** A relation name that will later collide with a fluent-surface verb. */
export interface VerbCollision {
  type: string
  relation: string
}

/**
 * The reserved relation names: the members the read handle actually shadows (kept in sync
 * via the runtime's {@link HANDLE_RESERVED}) plus the future Phase-3 write verbs. A relation
 * named like any of these must route through `.rel(name)`, so the codegen warns at build time.
 * (`type`/`id` from {@link HANDLE_RESERVED} can never be JSON:API relation names.)
 */
const RESERVED_VERBS = new Set<string>([
  ...HANDLE_RESERVED,
  'update',
  'delete',
  'create',
  'list',
  'actions',
])

/**
 * Find relations whose name shadows a reserved fluent-surface member (a handle accessor or a
 * future write verb). Such relations are routed via `.rel(name)`; the codegen warns at build time.
 */
export function detectVerbCollisions(descriptor: ApiDescriptor): VerbCollision[] {
  const collisions: VerbCollision[] = []
  for (const type of Object.keys(descriptor)) {
    for (const relation of Object.keys(descriptor[type]!.relations)) {
      if (RESERVED_VERBS.has(relation)) {
        collisions.push({ type, relation })
      }
    }
  }
  return collisions
}

function refName(ref: string): string | undefined {
  return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : undefined
}

function isSchema(value: SchemaOrBool | undefined): value is SchemaObject {
  return typeof value === 'object' && value !== null
}

/** PascalCase a JSON:API wire type for use in a TS identifier (e.g. `public-profiles` -> `PublicProfiles`). */
function pascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/** Emit a JSON-string literal (used for keys that aren't bare identifiers and enum members). */
function quote(value: string): string {
  return JSON.stringify(value)
}

/** True when a string is a safe bare object-key identifier. */
function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
}

function objectKey(value: string): string {
  return isIdentifier(value) ? value : quote(value)
}

/**
 * Render a description as a JSDoc comment at the given indent — single-line when it fits,
 * a block otherwise. Returns `undefined` for empty text. Neutralises any `*\/` so a
 * description can never terminate the comment early.
 */
function jsDoc(text: string | undefined, indent: string): string | undefined {
  const trimmed = text?.trim()
  if (!trimmed) {
    return undefined
  }
  const lines = trimmed.replace(/\*\//g, '* /').split('\n')
  if (lines.length === 1) {
    return `${indent}/** ${lines[0]} */`
  }
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`.trimEnd()),
    `${indent} */`,
  ].join('\n')
}

export class Emitter {
  private readonly schemas: Record<string, SchemaObject>
  /** Wire type -> the schema `Base` (the `<Base>Resource` name minus `Resource`). */
  private readonly baseByType: Map<string, string>
  /** Enum component names referenced by an attribute, in first-seen order. */
  private readonly usedEnums = new Map<string, SchemaObject>()
  /**
   * Component-schema names whose dedicated interface is emitted (e.g. `AlbumsAttributes`,
   * `AlbumsCreateAttributes`). A `$ref` to one of these resolves to the interface name
   * rather than being re-expanded structurally — so an action envelope nests the precise,
   * already-named attribute type. Populated as interfaces are emitted.
   */
  private readonly emittedInterfaces = new Set<string>()
  /** Component names mid-expansion in {@link tsType} — a cycle guard for self/mutually-referential `$ref`s. */
  private readonly expanding = new Set<string>()
  /**
   * The per-action alias names actually emitted, keyed `type -> actionName -> { input?; output? }`.
   * Populated by {@link actionTypeAliases}; consumed by {@link actionTypesMap} so the action
   * type-map only references aliases that exist (a `none` input/output contributes neither).
   */
  private readonly actionAliasNames = new Map<
    string,
    Map<string, { input?: string; output?: string }>
  >()

  /** Provenance of the source document, stamped into the generated header for drift tracking. */
  private readonly provenance: Provenance

  constructor(
    private readonly doc: OpenApiDocument,
    private readonly descriptor: ApiDescriptor,
    private readonly atomic: AtomicDescriptor | null,
  ) {
    this.schemas = doc.components?.schemas ?? {}
    this.baseByType = this.indexBases()
    this.provenance = deriveProvenance(doc)
  }

  /** Map each declared wire type back to the `Base` of its resource schema. */
  private indexBases(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [name, schema] of Object.entries(this.schemas)) {
      if (!name.endsWith('Resource') || name.endsWith('ResourceIdentifier')) {
        continue
      }
      const typeProp = schema.properties?.['type']
      if (isSchema(typeProp) && typeof typeProp.const === 'string') {
        out.set(typeProp.const, name.slice(0, -'Resource'.length))
      }
    }
    return out
  }

  emit(): string {
    // Resolve enums first so the alias block (which depends on `usedEnums`) is populated.
    const interfaces = Object.keys(this.descriptor).map((type) => this.attributeInterface(type))
    const writeInterfaces = Object.keys(this.descriptor).flatMap((type) =>
      this.writeAttributeInterfaces(type),
    )
    // Action input/output aliases reference component schemas; resolve them (this also
    // records any enums they reach) before the enum block is emitted.
    const actionAliases = this.actionTypeAliases()
    const enums = this.enumAliases()

    const parts = [
      this.header(),
      this.imports(),
      ...(enums ? [enums] : []),
      ...interfaces,
      ...writeInterfaces,
      ...actionAliases,
      this.attributesMap(),
      this.writeAttributesMap(),
      this.actionTypesMap(),
      this.resourceMap(),
      'export type ResourceMap = typeof resourceMap',
      this.atomicConst(),
      this.boundFactory(),
    ]
    return `${parts.join('\n\n')}\n`
  }

  private header(): string {
    return [
      '/**',
      ' * AUTO-GENERATED by @haddowg/json-api-codegen — do not edit by hand.',
      ' * Regenerate from the source OpenAPI document instead.',
      ' *',
      ...provenanceLines(this.provenance),
      ' */',
    ].join('\n')
  }

  private imports(): string {
    return [
      'import {',
      '  type ApiDescriptor,',
      '  type ClientOptions,',
      '  createClient as createClientRuntime,',
      "} from '@haddowg/json-api-client'",
    ].join('\n')
  }

  /** Per-type attribute interface, e.g. `export interface AlbumsAttributes { ... }`. */
  private attributeInterface(type: string): string {
    const base = this.baseByType.get(type)
    const props = base ? this.schemas[`${base}Attributes`]?.properties : undefined
    // Drive field order off the (sorted) descriptor so output stays deterministic; read
    // attributes are always present (every member required, no optional marker).
    const fields = Object.keys(this.descriptor[type]!.attributes)
    return this.renderInterface(`${pascalCase(type)}Attributes`, props, fields, () => true)
  }

  /**
   * The per-type WRITE attribute interfaces — `<Pascal>CreateAttributes` and
   * `<Pascal>UpdateAttributes` — from the `<Base>CreateAttributes`/`<Base>UpdateAttributes`
   * components (readOnly fields are already excluded vs the read attributes by the bundle).
   * Create marks a field required iff it sits in the component's `required`; Update makes
   * every field optional. A read-only type (no create/update component) contributes nothing.
   */
  private writeAttributeInterfaces(type: string): string[] {
    const base = this.baseByType.get(type)
    if (base === undefined) {
      return []
    }
    const pascal = pascalCase(type)
    const out: string[] = []

    const create = this.schemas[`${base}CreateAttributes`]
    if (create !== undefined) {
      const required = new Set(create.required ?? [])
      // Sort the schema's own property keys (no descriptor to order write fields).
      // oxlint-disable-next-line no-array-sort -- sorting a freshly-created key array
      const fields = Object.keys(create.properties ?? {}).sort()
      out.push(
        this.renderInterface(`${pascal}CreateAttributes`, create.properties, fields, (field) =>
          required.has(field),
        ),
      )
    }

    const update = this.schemas[`${base}UpdateAttributes`]
    if (update !== undefined) {
      // oxlint-disable-next-line no-array-sort -- sorting a freshly-created key array
      const fields = Object.keys(update.properties ?? {}).sort()
      out.push(
        this.renderInterface(`${pascal}UpdateAttributes`, update.properties, fields, () => false),
      )
    }

    return out
  }

  /**
   * Per-action input/output type aliases for every type that declares custom actions. An
   * action whose `input`/`output` resolves to a component schema gets a named alias
   * (`<Pascal><Action>Input` / `<Pascal><Action>Output`) expanding that component via the
   * shared {@link tsType} machinery — a `none` input/output (no body / a `204`) contributes
   * no alias. Deterministic order: types, then action names (the descriptor is sorted).
   */
  private actionTypeAliases(): string[] {
    const out: string[] = []
    for (const type of Object.keys(this.descriptor)) {
      const actions = this.descriptor[type]?.actions
      if (actions === undefined) {
        continue
      }
      const pascal = pascalCase(type)
      for (const [actionName, action] of Object.entries(actions)) {
        const member = `${pascal}${pascalCase(actionName)}`
        const names: { input?: string; output?: string } = {}
        const inputType = this.actionBodyType(action, 'input')
        if (inputType !== undefined) {
          out.push(`export type ${member}Input = ${inputType}`)
          names.input = `${member}Input`
        }
        const outputType = this.actionBodyType(action, 'output')
        if (outputType !== undefined) {
          out.push(`export type ${member}Output = ${outputType}`)
          names.output = `${member}Output`
        }
        if (names.input !== undefined || names.output !== undefined) {
          let byAction = this.actionAliasNames.get(type)
          if (byAction === undefined) {
            byAction = new Map()
            this.actionAliasNames.set(type, byAction)
          }
          byAction.set(actionName, names)
        }
      }
    }
    return out
  }

  /**
   * Emit the `ActionTypes` interface wiring the emitted per-action aliases onto the typed
   * action surface — `type -> actionName -> { input?; output? }`, the client's fourth type
   * argument. So `client.albums.id(id).actions.reissue(body)` takes `AlbumsReissueInput` and
   * resolves `AlbumsReissueOutput` rather than a loose `Record<string,unknown>` / `unknown`.
   * Only actions whose alias was emitted appear (a `none`-input/output action contributes the
   * absent side, which the runtime types fall back to loosely). Emits `{}` when none exist.
   */
  private actionTypesMap(): string {
    const typeLines: string[] = []
    for (const type of Object.keys(this.descriptor)) {
      const byAction = this.actionAliasNames.get(type)
      if (byAction === undefined || byAction.size === 0) {
        continue
      }
      const actionLines: string[] = []
      for (const [actionName, names] of byAction) {
        const members: string[] = []
        if (names.input !== undefined) {
          members.push(`input: ${names.input}`)
        }
        if (names.output !== undefined) {
          members.push(`output: ${names.output}`)
        }
        actionLines.push(`    ${objectKey(actionName)}: { ${members.join('; ')} }`)
      }
      typeLines.push(`  ${objectKey(type)}: {\n${actionLines.join('\n')}\n  }`)
    }
    if (typeLines.length === 0) {
      return 'export interface ActionTypes {}'
    }
    return `export interface ActionTypes {\n${typeLines.join('\n')}\n}`
  }

  /**
   * The TS type alias (if any) for an action's request body.
   *
   * An action's RESULT and its FLAT input are derived at the type level from the descriptor
   * (`outputType`/`outputCardinality` → the materialised resource view; `inputType` → the
   * `CreateInput` of that type), so no `output` alias is emitted and a `document` input whose
   * resource type resolves emits no `input` alias either. Only a bespoke command document (a
   * `document` input with no resolvable `inputType`) keeps a raw-envelope alias as its typed body,
   * expanded via {@link tsType} (falling back to a loose JSON:API document shape).
   */
  private actionBodyType(action: ActionDescriptor, side: 'input' | 'output'): string | undefined {
    if (side === 'output' || action.input !== 'document' || action.inputType !== undefined) {
      return undefined
    }
    const op = this.doc.paths?.[action.path]?.post
    const ref = op?.requestBody?.content?.[JSON_API_MEDIA_TYPE]?.schema?.$ref
    if (typeof ref !== 'string') {
      return LOOSE_DOCUMENT
    }
    const target = refName(ref)
    const resolved = target ? this.schemas[target] : undefined
    return resolved ? this.tsType(resolved) : LOOSE_DOCUMENT
  }

  /** Emit the server-level atomic capability constant (`{ path }` or `null`). */
  private atomicConst(): string {
    const doc = [
      '/**',
      ' * The server-level Atomic Operations endpoint (the atomic ext media type), or `null`',
      ' * when this server exposes none. The runtime `client.atomic` builder posts the batch here.',
      ' */',
    ].join('\n')
    const value = this.atomic === null ? 'null' : `${this.literal(this.atomic, 0)} as const`
    return `${doc}\nexport const atomic = ${value}`
  }

  /**
   * Render an attribute interface from a property map, a field order, and a `required`
   * predicate (true => no `?`). Shared by the read and write attribute interfaces so the
   * tsType/JSDoc logic stays in one place.
   */
  private renderInterface(
    name: string,
    props: Record<string, SchemaOrBool> | undefined,
    fields: readonly string[],
    required: (field: string) => boolean,
  ): string {
    const lines: string[] = []
    for (const field of fields) {
      const schema = props?.[field]
      const tsType = isSchema(schema) ? this.tsType(schema) : 'unknown'
      const doc = isSchema(schema) ? jsDoc(schema.description, '  ') : undefined
      if (doc) {
        lines.push(doc)
      }
      const optional = required(field) ? '' : '?'
      lines.push(`  ${objectKey(field)}${optional}: ${tsType}`)
    }

    this.emittedInterfaces.add(name)
    if (lines.length === 0) {
      return `export interface ${name} {}`
    }
    return `export interface ${name} {\n${lines.join('\n')}\n}`
  }

  /** Map a JSON Schema attribute node to a precise TypeScript type. */
  private tsType(schema: SchemaObject): string {
    // A reference: an enum -> its emitted union alias; an emitted attribute interface ->
    // its interface name (so an action envelope nests precise attribute types); else
    // structural expansion of the referenced component, falling back to unknown. A
    // `expanding` guard breaks any cyclic/self-referential component chain.
    if (typeof schema.$ref === 'string') {
      const target = refName(schema.$ref)
      const resolved = target ? this.schemas[target] : undefined
      if (target && resolved && Array.isArray(resolved.enum)) {
        this.usedEnums.set(target, resolved)
        return target
      }
      if (target && this.emittedInterfaces.has(target)) {
        return target
      }
      if (resolved === undefined || target === undefined || this.expanding.has(target)) {
        return 'unknown'
      }
      this.expanding.add(target)
      const expanded = this.tsType(resolved)
      this.expanding.delete(target)
      return expanded
    }

    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
    const nullable = types.includes('null')
    const base = this.baseTsType(
      schema,
      types.filter((t) => t !== 'null'),
    )
    return nullable ? `${base} | null` : base
  }

  /** The non-nullable TS type for the declared JSON type(s). */
  private baseTsType(schema: SchemaObject, types: readonly string[]): string {
    // An inline enum (string literals without a $ref).
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return schema.enum.map((value) => quote(String(value))).join(' | ')
    }
    if (types.length === 0) {
      return 'unknown'
    }
    const mapped = types.map((t) => this.scalarOrComposite(schema, t))
    // De-dupe while preserving order.
    return [...new Set(mapped)].join(' | ')
  }

  private scalarOrComposite(schema: SchemaObject, type: string): string {
    switch (type) {
      case 'string': {
        return 'string'
      }
      case 'number':
      case 'integer': {
        return 'number'
      }
      case 'boolean': {
        return 'boolean'
      }
      case 'object': {
        return this.objectType(schema)
      }
      case 'array': {
        return this.arrayType(schema)
      }
      default: {
        return 'unknown'
      }
    }
  }

  /** A nested object type from its `properties` (falls back to an index signature). */
  private objectType(schema: SchemaObject): string {
    const props = schema.properties
    if (props === undefined) {
      return 'Record<string, unknown>'
    }
    const required = new Set(schema.required ?? [])
    const members: string[] = []
    for (const [name, prop] of Object.entries(props)) {
      if (!isSchema(prop)) {
        continue
      }
      const optional = required.has(name) ? '' : '?'
      members.push(`${objectKey(name)}${optional}: ${this.tsType(prop)}`)
    }
    if (members.length === 0) {
      return 'Record<string, unknown>'
    }
    return `{ ${members.join('; ')} }`
  }

  private arrayType(schema: SchemaObject): string {
    const items = schema.items
    const element = isSchema(items) ? this.tsType(items) : 'unknown'
    // Wrap unions so `(A | B)[]` reads correctly.
    return /[|&]/.test(element) ? `(${element})[]` : `${element}[]`
  }

  /** Union aliases for every enum component an attribute referenced, sorted by name. */
  private enumAliases(): string | undefined {
    if (this.usedEnums.size === 0) {
      return undefined
    }
    // oxlint-disable-next-line no-array-sort -- sorting a freshly-created key array
    const names = [...this.usedEnums.keys()].sort()
    return names
      .map((name) => {
        const schema = this.usedEnums.get(name)!
        const values = schema.enum ?? []
        const union = values.map((value) => quote(String(value))).join(' | ')
        const alias = `export type ${name} = ${union}`
        const doc = jsDoc(this.enumDoc(schema), '')
        return doc ? `${doc}\n${alias}` : alias
      })
      .join('\n\n')
  }

  /**
   * Documentation for an enum alias: a per-value list built from `x-enum-descriptions`
   * (the richest hover DX, since a union alias can't carry per-member JSDoc), falling
   * back to the component's own `description`.
   */
  private enumDoc(schema: SchemaObject): string | undefined {
    const values = schema.enum ?? []
    const descriptions = schema['x-enum-descriptions']
    if (Array.isArray(descriptions) && descriptions.length === values.length && values.length > 0) {
      return values
        .map((value, i) => `- \`${String(value)}\` — ${String(descriptions[i])}`)
        .join('\n')
    }
    return schema.description
  }

  /**
   * Emit the `Attributes` interface mapping each wire type to its per-type attribute
   * interface. The runtime descriptor only carries coarse format hints; this is how the
   * precise per-type attribute types reach the bound client (passed as the second type
   * argument to the runtime factory).
   */
  private attributesMap(): string {
    const lines = Object.keys(this.descriptor).map(
      (type) => `  ${objectKey(type)}: ${pascalCase(type)}Attributes`,
    )
    return `export interface Attributes {\n${lines.join('\n')}\n}`
  }

  /**
   * Emit the `WriteAttributes` interface mapping each writable wire type to its
   * `{ create; update }` attribute pair. A read-only type (no create/update component)
   * contributes no entry, so the bound client only exposes writes where the API allows
   * them. Passed as the third type argument to the runtime factory.
   */
  private writeAttributesMap(): string {
    const lines: string[] = []
    for (const type of Object.keys(this.descriptor)) {
      const base = this.baseByType.get(type)
      const hasCreate = base !== undefined && this.schemas[`${base}CreateAttributes`] !== undefined
      const hasUpdate = base !== undefined && this.schemas[`${base}UpdateAttributes`] !== undefined
      if (!hasCreate && !hasUpdate) {
        continue
      }
      const pascal = pascalCase(type)
      const members: string[] = []
      if (hasCreate) {
        members.push(`create: ${pascal}CreateAttributes`)
      }
      if (hasUpdate) {
        members.push(`update: ${pascal}UpdateAttributes`)
      }
      lines.push(`  ${objectKey(type)}: { ${members.join('; ')} }`)
    }
    if (lines.length === 0) {
      return 'export interface WriteAttributes {}'
    }
    return `export interface WriteAttributes {\n${lines.join('\n')}\n}`
  }

  /** Emit the descriptor as a literal `as const satisfies ApiDescriptor`. */
  private resourceMap(): string {
    const body = this.literal(this.descriptor as Record<string, unknown>, 0)
    return `export const resourceMap = ${body} as const satisfies ApiDescriptor`
  }

  /** Render a JSON-serialisable descriptor value as deterministic TS object-literal source. */
  private literal(value: unknown, depth: number): string {
    const indent = '  '.repeat(depth)
    const inner = '  '.repeat(depth + 1)

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return '[]'
      }
      const items = value.map((item) => `${inner}${this.literal(item, depth + 1)}`)
      return `[\n${items.join(',\n')}\n${indent}]`
    }

    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length === 0) {
        return '{}'
      }
      const lines = entries.map(
        ([key, v]) => `${inner}${objectKey(key)}: ${this.literal(v, depth + 1)}`,
      )
      return `{\n${lines.join(',\n')}\n${indent}}`
    }

    return JSON.stringify(value)
  }

  private boundFactory(): string {
    return [
      '/**',
      ' * Descriptor-bound client factory; wraps the generic runtime with this API’s `resourceMap`.',
      ' * The server-level `atomic` capability is threaded in by default so `client.atomic` is wired',
      ' * (a caller may still override it via `options.atomic`).',
      ' */',
      'export const createClient = (options: ClientOptions) =>',
      '  createClientRuntime<typeof resourceMap, Attributes, WriteAttributes, ActionTypes>(',
      '    resourceMap,',
      '    {',
      '      atomic,',
      '      ...options,',
      '    },',
      '  )',
    ].join('\n')
  }
}

/**
 * Generate the full source of the client module for a document + its built descriptor.
 * The server-level atomic capability is derived from the document (override via `atomic`).
 */
export function emit(
  doc: OpenApiDocument,
  descriptor: ApiDescriptor,
  atomic: AtomicDescriptor | null = buildAtomic(doc),
): string {
  return new Emitter(doc, descriptor, atomic).emit()
}

/** Re-export so callers can reference the resource descriptor shape if needed. */
export type { ResourceDescriptor }
