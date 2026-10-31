# A multi-method action keeps its name for the preferred method

Each method of a multi-method action has its own operation id, but suffixing every method would rename the method existing clients already call. So the preferred method (`POST`, else the first advertised) keeps the bare name, and only the others get a key with the method appended (`exportGet`, or `bulk-import-get` when the name joins its words with a dash or underscore); the server refuses action names that differ only in case or punctuation, so that key can't land on another action.

## Consequences

The naming is asymmetric: `export` sends `POST` and nothing in its name says so.
