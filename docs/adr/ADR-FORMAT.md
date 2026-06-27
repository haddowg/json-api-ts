# ADR format

Architecture Decision Records for `json-api-ts`, following the lightweight convention
shared with `json-api` / `json-api-symfony`.

An ADR is short. The **title states the decision** (not the problem). The body is a
few sentences of *why* — the context, the decision, and the consequence of the
trade-off. Write one only when a decision is **hard to reverse**, **surprising without
context**, and **the result of a real trade-off**. If any of those is missing, it's a
comment or a CONTEXT.md note, not an ADR.

```
# NNNN — <decision stated as a title>

- **Status:** Accepted | Superseded by NNNN | …
- **Date:** YYYY-MM-DD

<1–3 short paragraphs: the context that forced the choice, the decision, and the
consequence / what we gave up.>
```

Number sequentially from `0001`. Never renumber.
