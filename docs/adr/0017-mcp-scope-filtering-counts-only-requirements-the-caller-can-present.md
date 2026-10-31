# MCP scope filtering counts only the requirements the caller can present

An operation's `security` lists alternatives, and one that names no scopes, such as a session cookie, passed for every token and listed every tool. So the filter counts an alternative only when every scheme it names is a credential scheme the MCP caller connects with, by default the document's `oauth2` schemes and otherwise the host's `credentialSchemes`; a document with no `oauth2` scheme counts every requirement, since guessing which `http` or `apiKey` scheme a caller holds would drop tools a host relies on. A `null` grant means no scopes and fails closed, unlike core's null-means-unrestricted, so a failed token lookup can't widen the list.

## Consequences

A bearer-only operation beside `oauth2` ones is left out until the host names `bearer`.
