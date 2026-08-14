# V3 Authoritative UI Wave 2 Design

## Scope

Wire the V3 frontend to the frozen public contracts and the authoritative
server implementation from `feat/server@4641061`. The frontend must stop
consuming internal room records, room-wide credentials, or generic ACK
shapes.

## Integration Baseline

Merge `main` first, then merge `feat/server@4641061`. Resolve shared contract
conflicts in favor of the current `main` versions under `shared/`. Server
implementation files come from `4641061` unless a frontend integration fix is
required and documented.

## Transport

`src/net/v3Socket.ts` imports all public response and message types from
`shared/`. Create, join, spectate, and resume return `{ room, credentials }`.
Socket authentication uses the current identity's `resumeToken`; `joinToken`
is supplied only for first entry. Event and snapshot listeners normalize
messages into envelopes carrying `roomId`, `gameId`, and sequence metadata.

Changing identity disconnects the old socket, clears its listeners and room
binding, and reconnects with the new resume token. No response is accepted
when its room/game identity differs from the active session.

## Session Store

Persist the smallest versioned session shape: actor identity, room code/id,
member mode, and scoped credentials. The store owns one atomic boundary reset
that clears room, snapshot, events, cursor, pending command state, and errors
before create, join, spectate, resume, identity replacement, or room change.

On initialization the store resumes with `resumeToken`, obtains the current
public room projection, fetches the personalized snapshot, and requests events
after `lastSeenSeq`. The cursor advances only for accepted events matching the
active `roomId` and `gameId`. A new game ID resets the prior game's events and
cursor.

## Room Shell And Actions

All active room states render at `/room/:roomCode`. The room projection decides
whether the viewer is waiting, playing, publicly spectating, or omnisciently
spectating. Legacy `/game`, `/spectate`, and `/monitor` routes redirect to the
active room URL when possible.

The action surface renders every action in the personalized
`allowedActions`. A centralized action matrix defines whether an action needs
text, a target, no target, or an optional target, and computes eligible targets
without granting authority beyond the server projection. Disabled and hidden
states follow the current projected action list; the server remains final
authority through `expectedStageRevision`.

## Visibility

Room ACKs are public `RoomView` values and never contain credentials, role
decks, session state, or internal players. Credentials are stored separately
and never added to snapshots or events. Incoming snapshots and events must
match the active room/game before entering state. Event visibility is checked
again client-side for the current `ViewerContext`; public spectators retain
only `public_timeline` events and masked player roles.

## Errors

All failures narrow through `ProtocolAck`. Stable command errors receive
specific UI messages. Revision, game, room, or identity mismatches trigger an
authoritative refresh or resume without replaying the rejected command.
Unauthenticated or invalid identity failures clear the active authority state
while retaining a visible recovery error.

## Verification

Add at least five focused frontend tests covering:

1. scoped credential persistence and resume-token authentication;
2. atomic identity/room reset;
3. room/game/sequence event isolation and gap recovery;
4. complete allowed-action rendering and target eligibility;
5. public spectator visibility and sensitive-key rejection.

Run the full test suite, server and root typechecks, lint, production build,
visibility verification, route rendering at 390/768/1440, and a real Socket.IO
flow for create, join, resume, cross-room isolation, and stale revision
rejection.
