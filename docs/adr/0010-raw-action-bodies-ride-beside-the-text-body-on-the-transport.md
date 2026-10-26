# 0010 — Raw action bodies ride beside the text body on the transport, and the caller picks the media type per call

- **Status:** Accepted
- **Date:** 2026-10-26

Generator contract 10 lets a custom action answer in media types other than JSON:API, such as a
CSV export, a PDF or an image, and an action can take several request media types, including
binary uploads and multipart forms. The transport seam moved strings in both directions, so a
binary body could neither be sent nor read. Widening `TransportRequest.body` and
`TransportResponse.body` would have broken every custom transport and test double that treats
them as JSON text, which is most of them, for traffic only a few actions produce.

The seam keeps `body: string` and gains optional members beside it: `rawBody` for a binary,
`FormData` or `URLSearchParams` request body, `responseType` to ask for a binary response, and
`binary` to return one. An error response is still text, so it parses into a `JsonApiError`. A
transport that ignores the new members keeps working for everything else; a binary response it
fails to read is reported as an error rather than handed back corrupted, though a `rawBody` it
ignores goes unsent, which is the cost of not breaking it.

The media type is a per-call option, `accept` for the response and `contentType` for the request,
typed from the descriptor so only declared types compile, rather than one generated method per
media type. JSON:API stays the default whenever an action declares it, so an action that grows a
raw sibling keeps its existing calls and results.
