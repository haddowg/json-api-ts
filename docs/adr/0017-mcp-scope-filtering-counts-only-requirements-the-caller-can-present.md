# 0017 — MCP scope filtering counts only the requirements the caller can present

- **Status:** Accepted
- **Date:** 2026-10-27

An operation's `security` lists alternatives, and the tool filter listed an operation when any
one passed. An alternative listing no scopes always passed, so an API that also accepts a session
cookie, such as `[{ oauth2: ['accounts:read'] }, { session: [] }]`, listed every tool for every
token. An MCP caller can only present the credentials it connected with, so the filter now counts
an alternative only when every scheme it names is a credential scheme. The generator records the
document's `oauth2` schemes in the model as `credentialSchemes`, and the host's
`credentialSchemes` option overrides them. An operation with security but no alternative the
caller can present is left out, and an empty or `{}` alternative stays public.

The model gains a field, so its format goes to 2 and an older runtime refuses it rather than
filter without it. The runtime still reads format 1, taking the schemes its operations list
scopes under. A document with no `oauth2` scheme records none and filters as before, since
guessing which `http` or `apiKey` scheme a caller holds would drop tools a host relies on; such a
host passes `credentialSchemes` itself. What we gave up is the old default for a mixed document:
a bearer-only operation beside `oauth2` ones is now left out until the host names `bearer`.
