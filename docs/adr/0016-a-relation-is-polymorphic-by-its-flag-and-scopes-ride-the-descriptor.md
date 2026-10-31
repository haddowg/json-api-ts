# A relation is polymorphic by its flag, and scopes ride the descriptor

The document writes a polymorphic relation as an `anyOf` union even over one type, so the codegen marks every union `polymorphic: true` and consumers ask `isPolymorphic()` rather than counting types, which lets an MCP tool take `{ type, id }` for it and keep its input when a second type arrives. Each operation's `oauth2` scopes go into the descriptor as optional lists, because the descriptor is what the MCP model and other consumers already carry, and an absent list costs every browser bundle less than an empty one.
