import {
  type ActionDescriptor,
  type ApiDescriptor,
  type AtomicDescriptor,
  HANDLE_RESERVED,
  type ResourceDescriptor,
} from '@haddowg/json-api-client'
import { buildAtomic } from './build-descriptor'
import { type DeclaredLink, readDeclaredLinks } from './declared-links'
import { actionOperation, operationExamples } from './build-examples'
import { emitErrorCodes, readErrorCatalogue } from './error-codes'
import type { OpenApiDocument, OperationObject, SchemaObject, SchemaOrBool } from './openapi'
import { deriveProvenance, provenanceLines, type Provenance } from './provenance'
import { commentLines, isTypeName, propertyKey, stringLiteral } from './source'
import { unwrapRefs } from './unwrap-refs'

const REF_PREFIX = '#/components/schemas/'
const JSON_API_MEDIA_TYPE = 'application/vnd.api+json'

/** A loose JSON:API document shape — the fallback an action body/result types as when its component can't be resolved. */
const LOOSE_DOCUMENT = 'Record<string, unknown>'

/** The per-action alias names wired into `ActionTypes`. */
interface ActionAliasNames {
  input?: string
  output?: string
  /** JSON-like raw response media type -> its alias. */
  responses?: Map<string, string>
  /** JSON-like request media type -> its alias. */
  requests?: Map<string, string>
}

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

/** The identifier stem for a wire type's interfaces, `Type`-prefixed when it would start with a digit. */
function typeStem(type: string): string {
  const pascal = pascalCase(type)
  return /^[A-Za-z]/.test(pascal) ? pascal : `Type${pascal}`
}

/** Names the generated module declares or relies on, which an enum alias must not take. */
const MODULE_NAMES = [
  'ActionTypes',
  'ApiDescriptor',
  'Attributes',
  'ClientOptions',
  'ErrorCode',
  'ErrorCodeByStatus',
  'ErrorCodeGuard',
  'ErrorCodes',
  'Links',
  'Record',
  'ResourceLinks',
  'ResourceMap',
  'WriteAttributes',
]

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
  const lines = commentLines(trimmed)
  if (lines.length === 1) {
    return `${indent}/** ${lines[0]} */`
  }
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`.trimEnd()),
    `${indent} */`,
  ].join('\n')
}

/** The validation keywords a member's TSDoc states, each as a tag of the same name. */
const CONSTRAINT_KEYWORDS = [
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
] as const

/** A tag value as TSDoc text: strings bare, a pattern or anything structured as code. */
function tagValue(keyword: string, value: unknown): string {
  if (keyword === 'pattern' || (typeof value !== 'string' && typeof value !== 'number')) {
    return `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``
  }
  return String(value)
}

/**
 * The TSDoc for an attribute: its description, then a tag per constraint the schema declares
 * (`@minLength 1`, `@pattern …`), its `@defaultValue`, any `@example` and `@deprecated`. Each
 * schema states the constraints of the context it describes, so a read member and its create
 * and update counterparts can document different bounds. The keywords are read off the member
 * and any inline `anyOf`/`oneOf` branch; a `$ref`'d component documents itself.
 */
function memberDoc(schema: SchemaObject): string | undefined {
  const layers = [
    schema,
    ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].filter(
      (branch) => branch.$ref === undefined,
    ),
  ]
  const tags: string[] = []
  for (const keyword of CONSTRAINT_KEYWORDS) {
    for (const layer of layers) {
      const value = layer[keyword]
      if (value === undefined || value === false) {
        continue
      }
      tags.push(value === true ? `@${keyword}` : `@${keyword} ${tagValue(keyword, value)}`)
      break
    }
  }
  if ('default' in schema) {
    tags.push(`@defaultValue \`${JSON.stringify(schema['default'])}\``)
  }
  const examples = Array.isArray(schema['examples']) ? [...(schema['examples'] as unknown[])] : []
  if ('example' in schema && !examples.includes(schema['example'])) {
    examples.unshift(schema['example'])
  }
  for (const example of examples) {
    tags.push(`@example ${typeof example === 'string' ? example : JSON.stringify(example)}`)
  }
  if (schema['deprecated'] === true) {
    tags.push('@deprecated')
  }
  const description = schema.description?.trim()
  if (tags.length === 0) {
    return description
  }
  return description ? `${description}\n\n${tags.join('\n')}` : tags.join('\n')
}

/** An `ActionTypes` media map: `{ 'text/csv': Alias; … }`. */
function mediaMap(aliases: Map<string, string>): string {
  const entries = [...aliases].map(([mediaType, alias]) => `${stringLiteral(mediaType)}: ${alias}`)
  return `{ ${entries.join('; ')} }`
}

/** The schema of `mediaType` under an operation's first 2xx response that lists it. */
function firstSuccessSchema(
  op: OperationObject | undefined,
  mediaType: string,
): SchemaObject | undefined {
  for (const [code, response] of Object.entries(op?.responses ?? {})) {
    const media = code.startsWith('2') ? response.content?.[mediaType] : undefined
    if (media !== undefined) {
      return media.schema
    }
  }
  return undefined
}

/**
 * An action's summary and description as JSDoc, leaving out the prose the projector writes for an
 * action whose author gave none ("Invoke the `name` action", "Invokes the `name` custom action on
 * …"), which says nothing the name doesn't.
 */
function actionDoc(name: string, op: OperationObject | undefined): string | undefined {
  const summary = op?.summary?.trim()
  const description = op?.description?.trim()
  const parts: string[] = []
  if (summary && summary !== `Invoke the \`${name}\` action`) {
    parts.push(summary)
  }
  const generated = new RegExp(`^Invokes the \`${escapeRegExp(name)}\` custom action on [^.]*\\.$`)
  if (description && !generated.test(description)) {
    parts.push(description)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

/**
 * What an action declares about its effects (generator contract 15), as one sentence, or
 * `undefined` when it declares nothing.
 */
function safetyDoc(action: ActionDescriptor): string | undefined {
  const flags: [boolean | undefined, string][] = [
    [action.readOnly, 'read-only'],
    [action.destructive, 'destructive'],
    [action.idempotent, 'idempotent'],
  ]
  const words = flags
    .filter(([value]) => value !== undefined)
    .map(([value, word]) => (value === true ? word : `not ${word}`))
  if (words.length === 0) {
    return undefined
  }
  const list =
    words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`
  return `The server declares this action ${list}.`
}

/**
 * What an action that answers with a URL returns (generator contract 17), as JSDoc, or
 * `undefined` for any other action.
 */
function locationDoc(action: ActionDescriptor): string | undefined {
  if (action.location === undefined) {
    return undefined
  }
  const serving = `a URL serving \`${action.location.mediaType}\``
  return action.output === 'location'
    ? `Returns ${serving} as an \`ActionLocation\`. The client doesn't follow it.`
    : `May return ${serving} instead, as an \`ActionLocation\`. The client doesn't follow it.`
}

/** A list of scopes as inline code joined into prose: `a`, `b` and `c`. */
function scopeList(scopes: readonly string[]): string {
  const quoted = scopes.map((scope) => `\`${scope}\``)
  return quoted.length === 1
    ? quoted[0]!
    : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)!}`
}

/** The sentence naming the OAuth scopes an operation needs (generator contract 16). */
function scopeDoc(scopes: readonly string[] | undefined): string | undefined {
  if (scopes === undefined || scopes.length === 0) {
    return undefined
  }
  return `Needs the OAuth ${scopes.length === 1 ? 'scope' : 'scopes'} ${scopeList(scopes)}.`
}

/** The descriptor's `paths` keys, by the operation whose scopes they carry. */
const PATH_OPERATIONS: Readonly<Record<string, string>> = {
  fetchMany: 'fetchCollection',
  create: 'create',
  fetchOne: 'fetchOne',
  update: 'update',
  delete: 'delete',
}

/** A relation's operations, in the order its JSDoc lists their scopes. */
const RELATION_OPERATIONS = [
  'fetchRelated',
  'fetchRelationship',
  'updateRelationship',
  'addRelationship',
  'removeRelationship',
] as const

/** The OAuth scopes each of a relation's endpoints needs, one line per operation, or `undefined`. */
function relationScopeDoc(
  scopes: Readonly<Record<string, readonly string[]>> | undefined,
  relation: string,
): string | undefined {
  const lines = RELATION_OPERATIONS.flatMap((operation) => {
    const needed = scopes?.[`${operation}.${relation}`]
    return needed === undefined || needed.length === 0
      ? []
      : [`- \`${operation}\` needs ${scopeList(needed)}`]
  })
  return lines.length === 0 ? undefined : ['OAuth scopes:', '', ...lines].join('\n')
}

/** The most lines of example JSON an action's `@example` shows; a longer one is left out. */
export const EXAMPLE_DOC_MAX_LINES = 80

/** Whether a media type carries JSON: JSON:API, `application/json` or a `+json` suffix. */
function isJsonMedia(mediaType: string): boolean {
  const essence = mediaType.split(';')[0]!.trim().toLowerCase()
  return essence === 'application/json' || essence.endsWith('+json')
}

/** The media type to show: JSON:API when it has an example, else the first that does. */
function shownMedia(examples: Readonly<Record<string, unknown>>): string | undefined {
  return JSON_API_MEDIA_TYPE in examples ? JSON_API_MEDIA_TYPE : Object.keys(examples)[0]
}

/**
 * An `@example` for an action: its request body when it declares one, else its first success
 * response, as a fenced block of pretty-printed JSON (a text body as is). A body over
 * {@link EXAMPLE_DOC_MAX_LINES} lines is named but not shown. The fence is longer than any run of
 * backticks in the body, so the body can't close it.
 */
function exampleDoc(op: OperationObject | undefined): string | undefined {
  const examples = operationExamples(op)
  if (examples === undefined) {
    return undefined
  }
  let label: string
  let media: Readonly<Record<string, unknown>>
  if (examples.request !== undefined) {
    label = 'Request body'
    media = examples.request
  } else {
    const first = Object.entries(examples.responses ?? {})[0]
    if (first === undefined) {
      return undefined
    }
    label = `Response \`${first[0]}\``
    media = first[1]
  }
  const mediaType = shownMedia(media)
  if (mediaType === undefined) {
    return undefined
  }
  if (mediaType !== JSON_API_MEDIA_TYPE) {
    label += ` as \`${mediaType}\``
  }
  const value = media[mediaType]
  const raw = typeof value === 'string' && !isJsonMedia(mediaType)
  const text = raw ? value.replace(/(?:\r\n|\r|\n)+$/, '') : JSON.stringify(value, null, 2)
  const lines = text.split(/\r\n|\r|\n/).length
  if (lines > EXAMPLE_DOC_MAX_LINES) {
    return `@example ${label}\nThe example is ${lines} lines long, too long to show here.`
  }
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const language = raw ? '' : 'json'
  return `@example ${label}\n${fence}${language}\n${text}\n${fence}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
  /** Enum component name -> the alias name it's emitted under. */
  private readonly enumNames = new Map<string, string>()
  /** Type names already spoken for: the module's own, the per-type interfaces and enum aliases. */
  private readonly takenNames: Set<string>
  /** Component names mid-expansion in {@link tsType} — a cycle guard for self/mutually-referential `$ref`s. */
  private readonly expanding = new Set<string>()
  /**
   * The per-action alias names actually emitted, keyed `type -> actionName -> { input?; output? }`.
   * Populated by {@link actionTypeAliases}; consumed by {@link actionTypesMap} so the action
   * type-map only references aliases that exist (a `none` input/output contributes neither).
   */
  private readonly actionAliasNames = new Map<string, Map<string, ActionAliasNames>>()
  /** Raw body components already emitted as a named alias, by component name. */
  private readonly rawBodyAliases = new Map<string, string>()
  /** JSDoc for entries of the `resourceMap` literal, keyed by their path joined with `/`. */
  private readonly literalDocs = new Map<string, string>()

  /** Wire type -> the links it declares, for the types that declare any. */
  private readonly declaredLinks = new Map<string, DeclaredLink[]>()

  /** Provenance of the source document, stamped into the generated header for drift tracking. */
  private readonly provenance: Provenance

  private readonly doc: OpenApiDocument

  constructor(
    source: OpenApiDocument,
    private readonly descriptor: ApiDescriptor,
    private readonly atomic: AtomicDescriptor | null,
  ) {
    this.doc = unwrapRefs(source)
    this.schemas = this.doc.components?.schemas ?? {}
    this.baseByType = this.indexBases()
    this.provenance = deriveProvenance(source)
    this.takenNames = new Set(MODULE_NAMES)
    for (const type of Object.keys(descriptor)) {
      const base = this.baseByType.get(type)
      const links =
        base === undefined ? [] : readDeclaredLinks(this.schemas[`${base}ResourceLinks`])
      if (links.length > 0) {
        this.declaredLinks.set(type, links)
      }
    }
    for (const type of Object.keys(descriptor)) {
      const stem = typeStem(type)
      for (const suffix of ['Attributes', 'CreateAttributes', 'UpdateAttributes', 'Links']) {
        this.takenNames.add(`${stem}${suffix}`)
      }
      for (const [name, action] of Object.entries(descriptor[type]?.actions ?? {})) {
        this.takenNames.add(`${stem}${pascalCase(name)}Input`)
        this.takenNames.add(`${stem}${pascalCase(name)}Output`)
        for (const { mediaType } of action.rawOutput ?? []) {
          this.takenNames.add(`${stem}${pascalCase(name)}${pascalCase(mediaType)}Output`)
        }
        for (const { mediaType } of action.inputMedia ?? []) {
          this.takenNames.add(`${stem}${pascalCase(name)}${pascalCase(mediaType)}Input`)
        }
        const single = action.contentType
        if (
          single !== undefined &&
          (single.startsWith('multipart/') || single === 'application/x-www-form-urlencoded')
        ) {
          this.takenNames.add(`${stem}${pascalCase(name)}${pascalCase(single)}Input`)
        }
        const op = actionOperation(this.doc, action)
        // A multi-method action's other methods are keyed apart from the name the server prose uses.
        const wireName = action.path.slice(action.path.lastIndexOf('/') + 1)
        const parts = [
          actionDoc(wireName, op),
          locationDoc(action),
          safetyDoc(action),
          scopeDoc(action.scopes),
          exampleDoc(op),
        ].filter((part) => part !== undefined)
        const doc = parts.length === 0 ? undefined : parts.join('\n\n')
        if (doc !== undefined) {
          this.literalDocs.set(`${type}/actions/${name}`, doc)
        }
      }
      const scopes = descriptor[type]?.scopes
      for (const [key, operation] of Object.entries(PATH_OPERATIONS)) {
        const doc = scopeDoc(scopes?.[operation])
        if (doc !== undefined && descriptor[type]?.paths[key] !== undefined) {
          this.literalDocs.set(`${type}/paths/${key}`, doc)
        }
      }
      for (const relation of Object.keys(descriptor[type]?.relations ?? {})) {
        const doc = relationScopeDoc(scopes, relation)
        if (doc !== undefined) {
          this.literalDocs.set(`${type}/relations/${relation}`, doc)
        }
      }
    }
  }

  /**
   * The alias an enum component is emitted under: its own name when that's a usable type name,
   * else one derived from it (with a warning), kept clear of every other name in the module.
   */
  private enumName(component: string): string {
    const known = this.enumNames.get(component)
    if (known !== undefined) {
      return known
    }
    let name = component
    if (!isTypeName(component) || this.takenNames.has(component)) {
      const pascal = pascalCase(component)
      let stem = /^[A-Za-z]/.test(pascal) ? pascal : `Enum${pascal}`
      if (!isTypeName(stem) || this.takenNames.has(stem)) {
        stem = `${stem}Enum`
      }
      name = stem
      for (let n = 2; this.takenNames.has(name); n++) {
        name = `${stem}${n}`
      }
      console.warn(
        `Enum component ${stringLiteral(component)} can't be used as a TypeScript type name; emitting it as ${name}.`,
      )
    }
    this.takenNames.add(name)
    this.enumNames.set(component, name)
    return name
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
    const linkInterfaces = [...this.declaredLinks].map(([type, links]) =>
      this.linksInterface(type, links),
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
      ...linkInterfaces,
      ...actionAliases,
      this.attributesMap(),
      this.writeAttributesMap(),
      this.linksMap(),
      this.actionTypesMap(),
      this.resourceMap(),
      'export type ResourceMap = typeof resourceMap',
      this.atomicConst(),
      this.pageLimitsConst(),
      emitErrorCodes(readErrorCatalogue(this.doc)),
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
      '  type ErrorCodeGuard,',
      '  hasErrorCode as hasErrorCodeRuntime,',
      ...(this.declaredLinks.size > 0 ? ['  type ResourceLinks,'] : []),
      "} from '@haddowg/json-api-client'",
    ].join('\n')
  }

  /**
   * The links interface of a type that declares links, e.g. `ImagesLinks`: each declared link an
   * optional member, since the server leaves a link out when its href resolves to `null`. It
   * extends the loose `ResourceLinks`, so `self` and any link the type doesn't declare stay
   * reachable as before.
   */
  private linksInterface(type: string, links: readonly DeclaredLink[]): string {
    const lines: string[] = []
    for (const link of links) {
      const doc = jsDoc(memberDoc(link.schema), '  ')
      if (doc !== undefined) {
        lines.push(doc)
      }
      const value = link.kind === 'bare' ? 'string' : this.linkObjectType(link.schema, '  ')
      lines.push(`  ${propertyKey(link.name)}?: ${value}`)
    }
    return `export interface ${typeStem(type)}Links extends ResourceLinks {\n${lines.join('\n')}\n}`
  }

  /**
   * A declared link object as a multi-line type: `href`, each static member as its `const`, and a
   * `meta` object whose members are typed as attributes are, each with its own TSDoc.
   */
  private linkObjectType(schema: SchemaObject, indent: string): string {
    return this.documentedObject(schema, indent, (name, member) =>
      name === 'meta'
        ? this.documentedObject(member, `${indent}  `, (_, field) => this.tsType(field))
        : this.constOrType(member),
    )
  }

  /** An object type with one line, and its TSDoc, per property. */
  private documentedObject(
    schema: SchemaObject,
    indent: string,
    type: (name: string, member: SchemaObject) => string,
  ): string {
    const required = new Set(schema.required ?? [])
    const inner = `${indent}  `
    const lines: string[] = []
    for (const [name, member] of Object.entries(schema.properties ?? {})) {
      if (!isSchema(member)) {
        continue
      }
      const doc = jsDoc(memberDoc(member), inner)
      if (doc !== undefined) {
        lines.push(doc)
      }
      lines.push(
        `${inner}${propertyKey(name)}${required.has(name) ? '' : '?'}: ${type(name, member)}`,
      )
    }
    return lines.length === 0 ? 'Record<string, unknown>' : `{\n${lines.join('\n')}\n${indent}}`
  }

  /** A static link member's `const` as a literal type, else its schema's type. */
  private constOrType(schema: SchemaObject): string {
    const value = schema['const']
    return typeof value === 'string' ? stringLiteral(value) : this.tsType(schema)
  }

  /** Per-type attribute interface, e.g. `export interface AlbumsAttributes { ... }`. */
  private attributeInterface(type: string): string {
    const base = this.baseByType.get(type)
    const props = base ? this.schemas[`${base}Attributes`]?.properties : undefined
    // Drive field order off the (sorted) descriptor so output stays deterministic; read
    // attributes are always present (every member required, no optional marker).
    const fields = Object.keys(this.descriptor[type]!.attributes)
    return this.renderInterface(`${typeStem(type)}Attributes`, props, fields, () => true)
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
    const pascal = typeStem(type)
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
      const pascal = typeStem(type)
      for (const [actionName, action] of Object.entries(actions)) {
        const member = `${pascal}${pascalCase(actionName)}`
        const names: ActionAliasNames = {}
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
        const op = actionOperation(this.doc, action)
        for (const { mediaType, kind } of action.rawOutput ?? []) {
          if (kind === 'json') {
            const schema = firstSuccessSchema(op, mediaType)
            names.responses ??= new Map()
            names.responses.set(
              mediaType,
              this.rawBodyAlias(schema, `${member}${pascalCase(mediaType)}Output`, out),
            )
          }
        }
        const single = action.input === 'raw' && action.inputMedia === undefined
        const singleKind = !single
          ? undefined
          : action.contentType?.startsWith('multipart/') === true
            ? 'multipart'
            : action.contentType === 'application/x-www-form-urlencoded'
              ? 'form'
              : undefined
        const listed =
          action.inputMedia ??
          (singleKind === undefined || action.contentType === undefined
            ? []
            : [{ mediaType: action.contentType, kind: singleKind }])
        for (const { mediaType, kind } of listed) {
          const schema = op?.requestBody?.content?.[mediaType]?.schema
          if (kind === 'json') {
            names.requests ??= new Map()
            names.requests.set(
              mediaType,
              this.rawBodyAlias(schema, `${member}${pascalCase(mediaType)}Input`, out),
            )
          } else if (kind === 'multipart' || kind === 'form') {
            const fields = this.formFieldsType(schema, kind)
            if (fields !== undefined) {
              const alias = `${member}${pascalCase(mediaType)}Input`
              const doc = schema === undefined ? undefined : jsDoc(schema.description, '')
              const declaration = `export type ${alias} = ${fields}`
              out.push(doc === undefined ? declaration : `${doc}\n${declaration}`)
              names.requests ??= new Map()
              names.requests.set(mediaType, alias)
            }
          }
        }
        if (
          names.input !== undefined ||
          names.output !== undefined ||
          names.responses !== undefined ||
          names.requests !== undefined
        ) {
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
   * The alias a JSON-like raw body is typed by. A `$ref` to a component is emitted once under the
   * component's own name when that name is free; anything else gets `fallback`. The alias source
   * is pushed onto `out` the first time.
   */
  private rawBodyAlias(schema: SchemaObject | undefined, fallback: string, out: string[]): string {
    const target = typeof schema?.$ref === 'string' ? refName(schema.$ref) : undefined
    const resolved = target === undefined ? undefined : this.schemas[target]
    if (target !== undefined && resolved !== undefined) {
      const known = this.rawBodyAliases.get(target)
      if (known !== undefined) {
        return known
      }
      if (isTypeName(target) && !this.takenNames.has(target) && !Array.isArray(resolved.enum)) {
        this.takenNames.add(target)
        this.rawBodyAliases.set(target, target)
        out.push(this.rawBodyDeclaration(target, resolved))
        this.emittedInterfaces.add(target)
        return target
      }
    }
    out.push(this.rawBodyDeclaration(fallback, schema))
    return fallback
  }

  /**
   * The typed fields of a multipart or URL-encoded request body whose object schema lists
   * `properties`, which the client encodes into a `FormData` or `URLSearchParams`. `undefined`
   * when the schema lists none, so the body stays a raw `FormData` or `URLSearchParams`.
   */
  private formFieldsType(
    schema: SchemaObject | undefined,
    kind: 'multipart' | 'form',
  ): string | undefined {
    let target = schema
    if (typeof target?.$ref === 'string') {
      target = this.schemas[refName(target.$ref) ?? '']
    }
    const props = target?.properties
    if (target === undefined || props === undefined) {
      return undefined
    }
    const required = new Set(target.required ?? [])
    const members: string[] = []
    const valueTypes: string[] = []
    for (const [name, prop] of Object.entries(props)) {
      if (!isSchema(prop)) {
        continue
      }
      const type = this.formFieldType(prop, kind)
      valueTypes.push(type)
      members.push(`${propertyKey(name)}${required.has(name) ? '' : '?'}: ${type}`)
    }
    if (members.length === 0) {
      return undefined
    }
    const extra = target['additionalProperties']
    if (extra === true || isSchema(extra as SchemaOrBool | undefined)) {
      // An index signature must admit every declared member's type too.
      const additional = isSchema(extra as SchemaOrBool | undefined)
        ? this.formFieldType(extra as SchemaObject, kind)
        : this.formFieldType({}, kind)
      const all = [...new Set([...valueTypes, additional].flatMap((type) => type.split(' | ')))]
      members.push(`[field: string]: ${all.join(' | ')} | undefined`)
    }
    return `{ ${members.join('; ')} }`
  }

  /**
   * One form field's type: `Blob | File` for a binary part of a multipart body, an array of
   * its item type for an array, else the scalar's own type. A field with no usable type takes
   * any scalar a form can carry.
   */
  private formFieldType(schema: SchemaObject, kind: 'multipart' | 'form'): string {
    const any =
      kind === 'multipart' ? 'string | number | boolean | Blob' : 'string | number | boolean'
    let target = schema
    if (typeof target.$ref === 'string') {
      const resolved = this.schemas[refName(target.$ref) ?? '']
      if (resolved !== undefined && !Array.isArray(resolved.enum)) {
        target = resolved
      }
    }
    if (kind === 'multipart' && target.format === 'binary') {
      return 'Blob | File'
    }
    if (target.type === 'array') {
      const item = target.items === undefined ? any : this.formFieldType(target.items, kind)
      return item.includes(' ') ? `(${item})[]` : `${item}[]`
    }
    const type = this.tsType(target)
    return type === 'unknown' || type.includes('{') || type.startsWith('Record<') ? any : type
  }

  /** `export type Name = …` for a raw body schema, with its description as JSDoc. */
  private rawBodyDeclaration(name: string, schema: SchemaObject | undefined): string {
    const type = schema === undefined ? 'unknown' : this.tsType(schema)
    const doc = schema === undefined ? undefined : jsDoc(schema.description, '')
    const declaration = `export type ${name} = ${type}`
    return doc === undefined ? declaration : `${doc}\n${declaration}`
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
        if (names.responses !== undefined) {
          members.push(`responses: ${mediaMap(names.responses)}`)
        }
        if (names.requests !== undefined) {
          members.push(`requests: ${mediaMap(names.requests)}`)
        }
        actionLines.push(`    ${propertyKey(actionName)}: { ${members.join('; ')} }`)
      }
      typeLines.push(`  ${propertyKey(type)}: {\n${actionLines.join('\n')}\n  }`)
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
    const atomicScopes = scopeDoc(this.atomic?.scopes)
    const doc = [
      '/**',
      ' * The server-level Atomic Operations endpoint (the atomic ext media type), or `null`',
      ' * when this server exposes none. The runtime `client.atomic` builder posts the batch here.',
      ...(atomicScopes === undefined ? [] : [' *', ` * ${atomicScopes}`]),
      ' */',
    ].join('\n')
    const value = this.atomic === null ? 'null' : `${this.literal(this.atomic, 0)} as const`
    return `${doc}\nexport const atomic = ${value}`
  }

  /**
   * The `pageLimits` const: per collection, the `default`, `minimum` and `maximum` each `page`
   * member declares (generator contract 5 adds the paginator's default and page-size cap). A
   * menu nests them under each arm's `kind`. Members declaring none, and collections with no
   * such member, are left out. The client never clamps a `page` argument to these.
   */
  private pageLimitsConst(): string {
    const typeLines: string[] = []
    for (const type of Object.keys(this.descriptor)) {
      const path = this.descriptor[type]!.paths['fetchMany']
      const page = path === undefined ? undefined : this.doc.paths?.[path]?.get?.parameters
      const schema = page?.find((param) => param.name === 'page')?.schema
      if (schema === undefined) {
        continue
      }
      let body: string[] = []
      if (schema.oneOf !== undefined) {
        for (const arm of schema.oneOf) {
          const kind = isSchema(arm.properties?.['kind']) ? arm.properties['kind'].const : undefined
          const members = this.pageMemberLimits(arm, '      ')
          if (typeof kind === 'string' && members.length > 0) {
            body.push(`    ${propertyKey(kind)}: {\n${members.join('\n')}\n    },`)
          }
        }
      } else {
        body = this.pageMemberLimits(schema, '    ')
      }
      if (body.length > 0) {
        typeLines.push(`  ${propertyKey(type)}: {\n${body.join('\n')}\n  },`)
      }
    }
    const doc = [
      '/**',
      " * The bounds each collection's `page` parameter declares, keyed by type, then by strategy for a",
      ' * collection offering several, then by wire key. `default` is what the server uses when the key',
      ' * is absent and `maximum` is the largest value it serves. The client sends the `page` you pass',
      ' * unchanged, so read these to bound a page-size picker.',
      ' */',
    ].join('\n')
    const body = typeLines.length === 0 ? '{}' : `{\n${typeLines.join('\n')}\n}`
    return `${doc}\nexport const pageLimits = ${body} as const`
  }

  /** One page schema's members that declare a `default`, `minimum` or `maximum`, as literal lines. */
  private pageMemberLimits(schema: SchemaObject, indent: string): string[] {
    const lines: string[] = []
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      if (!isSchema(prop) || name === 'kind') {
        continue
      }
      const limits: string[] = []
      for (const keyword of ['default', 'minimum', 'maximum'] as const) {
        if (typeof prop[keyword] === 'number') {
          limits.push(`${keyword}: ${String(prop[keyword])}`)
        }
      }
      if (limits.length === 0) {
        continue
      }
      const doc = jsDoc(memberDoc(prop), indent)
      if (doc !== undefined) {
        lines.push(doc)
      }
      lines.push(`${indent}${propertyKey(name)}: { ${limits.join(', ')} },`)
    }
    return lines
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
      const doc = isSchema(schema) ? jsDoc(memberDoc(schema), '  ') : undefined
      if (doc) {
        lines.push(doc)
      }
      const optional = required(field) ? '' : '?'
      lines.push(`  ${propertyKey(field)}${optional}: ${tsType}`)
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
        return this.enumName(target)
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

    // A union of branches, as `anyOf: [{ $ref: Enum }, { type: 'null' }]` for a nullable enum.
    const branches = schema.anyOf ?? schema.oneOf
    if (schema.type === undefined && branches !== undefined && branches.length > 0) {
      const members = branches.map((branch) => this.tsType(branch))
      const nullable = members.includes('null')
      const rest = [...new Set(members.filter((member) => member !== 'null'))]
      if (rest.length === 0) {
        return 'null'
      }
      return nullable ? `${rest.join(' | ')} | null` : rest.join(' | ')
    }

    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
    if (types.length === 1 && types[0] === 'null') {
      return 'null'
    }
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
      return schema.enum.map((value) => stringLiteral(String(value))).join(' | ')
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
      members.push(`${propertyKey(name)}${optional}: ${this.tsType(prop)}`)
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
    const list = /[|&]/.test(element) ? `(${element})[]` : `${element}[]`
    // `minItems` of 1 or more: the server never sends, or accepts, an empty list.
    const minItems = schema['minItems']
    return typeof minItems === 'number' && minItems >= 1 ? `[${element}, ...${list}]` : list
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
        const union = values.map((value) => stringLiteral(String(value))).join(' | ')
        const alias = `export type ${this.enumName(name)} = ${union}`
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
      (type) => `  ${propertyKey(type)}: ${typeStem(type)}Attributes`,
    )
    return `export interface Attributes {\n${lines.join('\n')}\n}`
  }

  /**
   * Emit the `Links` interface mapping each type that declares links to its links interface. The
   * runtime threads it beside the `Attributes` map, so a read result's `$links` carries the
   * declared links. A type absent from it keeps the loose `ResourceLinks`. Passed as the sixth
   * type argument to the runtime factory.
   */
  private linksMap(): string {
    const lines = [...this.declaredLinks.keys()].map(
      (type) => `  ${propertyKey(type)}: ${typeStem(type)}Links`,
    )
    if (lines.length === 0) {
      return 'export interface Links {}'
    }
    return `export interface Links {\n${lines.join('\n')}\n}`
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
      const pascal = typeStem(type)
      const members: string[] = []
      if (hasCreate) {
        members.push(`create: ${pascal}CreateAttributes`)
      }
      if (hasUpdate) {
        members.push(`update: ${pascal}UpdateAttributes`)
      }
      lines.push(`  ${propertyKey(type)}: { ${members.join('; ')} }`)
    }
    if (lines.length === 0) {
      return 'export interface WriteAttributes {}'
    }
    return `export interface WriteAttributes {\n${lines.join('\n')}\n}`
  }

  /** Emit the descriptor as a literal `as const satisfies ApiDescriptor`. */
  private resourceMap(): string {
    const body = this.literal(this.descriptor as Record<string, unknown>, 0, '')
    return `export const resourceMap = ${body} as const satisfies ApiDescriptor`
  }

  /** Render a JSON-serialisable descriptor value as deterministic TS object-literal source. */
  private literal(value: unknown, depth: number, path?: string): string {
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
      const lines = entries.map(([key, v]) => {
        const childPath = path === undefined ? undefined : path === '' ? key : `${path}/${key}`
        const line = `${inner}${propertyKey(key)}: ${this.literal(v, depth + 1, childPath)}`
        const doc = childPath === undefined ? undefined : this.literalDocs.get(childPath)
        return doc === undefined ? line : `${jsDoc(doc, inner)}\n${line}`
      })
      return `{\n${lines.join(',\n')}\n${indent}}`
    }

    return typeof value === 'string' ? stringLiteral(value) : JSON.stringify(value)
  }

  private boundFactory(): string {
    return [
      '/**',
      ' * Descriptor-bound client factory; wraps the generic runtime with this API’s `resourceMap`.',
      ' * The server-level `atomic` capability is threaded in by default so `client.atomic` is wired',
      ' * (a caller may still override it via `options.atomic`). The client type carries `ErrorCode`,',
      ' * so bindings that only see the client (the Angular refs) type its errors.',
      ' */',
      'export const createClient = (options: ClientOptions) =>',
      '  createClientRuntime<typeof resourceMap, Attributes, WriteAttributes, ActionTypes, ErrorCode, Links>(',
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
