# 0013 — A multi-method action keeps its name for the preferred method

- **Status:** Accepted
- **Date:** 2026-10-26

Generator contract 15 gives each method of a multi-method action its own operation id,
`action.<type>.<path>.<method>`. Before it, the codegen read one operation per action path,
`POST` when advertised and otherwise the first method, and exposed it under the action's name.
Suffixing every method would have matched the ids, but it would rename that existing method and
break every client that calls it. So the preferred method keeps the bare name, and only the
other methods get a new key: the name plus the method, `exportGet`, or `bulk-import-get` when
the name joins its words with a dash or underscore. Core refuses two action ids that differ
only in case or punctuation, so the new key can't land on another action's name. A document
whose methods share one id is read as before, with only the preferred method, so an older
document generates the same client.

The naming is asymmetric. `export` sends `POST` while `exportGet` sends `GET`, and nothing in
the name says the first one is a `POST`. An action's safety flags go on its descriptor entry
as optional `readOnly`, `destructive` and `idempotent`, mirroring `x-safety` key for key, so a
tool reading the descriptor and one reading the document see the same names.
