# Attribute values pass through as the wire carries them

A date or date-time stays an ISO string and a decimal a number, rather than being coerced to `Date` or a decimal type, so a result serialises, caches and crosses SSR unchanged and no timezone conversion happens behind the caller's back. Coercion would read better at the call site, but results would need reviving after every serialisation, and changing the generated types now would break every consumer.
