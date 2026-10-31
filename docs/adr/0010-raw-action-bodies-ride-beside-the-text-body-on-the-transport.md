# Raw action bodies ride beside the text body on the transport, and the caller picks the media type per call

Some custom actions take or answer in other media types than JSON:API (CSV, PDF, images, multipart forms), but widening the transport's string `body` would break every custom transport and test double that treats it as JSON text. So `body` stays a string and the seam gains optional `rawBody`, `responseType` and `binary`, and the media type is a per-call `accept` or `contentType` typed from the descriptor rather than one generated method per media type; JSON:API stays the default whenever an action declares it.

## Consequences

A transport that ignores the new members keeps working for everything else, and a binary response it can't read is reported as an error, but a `rawBody` it ignores goes unsent.
