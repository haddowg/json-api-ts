# An accepted write is typed as a union, and waiting is opt-in at the call site

A write or action that declares a `202 Accepted` resolves to its usual result or an `Accepted` job, and the caller narrows it with `isAccepted()` or passes `wait` to poll straight away, which an overload types as the plain result. Polling by default would hold a call open for as long as the server's job runs, which a form submission or a TanStack mutation may not want, and a job type is a real resource worth showing while it runs. A job fails only through HTTP: a non-2xx on the job URL throws the usual `JsonApiError`, so the client has no failed-job hook to agree with the server on. Only the operations whose spec declares a `202` change type, so every other write keeps its exact signature.

## Consequences

The finished result is the resource the job URL ends at, which the `fetch` transport reaches by following the `303`. The write's `include` and `fields` don't reach it, so a waiting call and `$poll()` are typed without them. A pending job is told from a finished one by its type, or by a meta-only document for a meta-only job, so an action whose job and result are both meta-only documents can't finish through a followed redirect and times out.
