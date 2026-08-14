# W3-P2 Waiting Room Member Refresh Design

## Problem

The V3 waiting room renders `room.members` from the last `RoomView` ACK.
Joining and disconnecting members update server persistence, but the current
transport does not broadcast a waiting-room `RoomView` to existing clients.
The host therefore remains on the original `1 / 12` projection.

## Scope

This fix is frontend-only. It does not add or change server events. The
missing server-side waiting-room member broadcast is recorded in
`v3plan/FINDINGS.md` for a later server lane.

## Design

Add a pure waiting-room comparison that matches the active room against its
public `RoomSummary`. A refresh is required when:

- the summary is missing or no longer reports `waiting`;
- `playerCount` differs from the projected player-member count;
- `onlinePlayers` differs from the connected player-member count; or
- `spectatorCount` differs from the projected spectator-member count.

While the active room is waiting, the V3 store periodically calls the existing
room-list endpoint. It always updates the lobby summaries. When the active
summary differs from the local `RoomView`, the store invokes the existing
resume flow once to fetch a complete, viewer-specific `RoomView`.

The current server binds the resumed waiting-room identity but then rejects
event replay with `GAME_NOT_STARTED`, so the frontend keeps a summary-only
fallback. That fallback preserves known members, appends stable placeholder
seats for new members, and applies the authoritative aggregate online count.
It does not invent credentials, permissions, or gameplay state. Once the
server can broadcast or resume a complete waiting-room `RoomView`, the same
flow prefers the server projection and the placeholders disappear.

The probe is guarded against overlapping refresh and recovery calls. It stops
when the store is disposed, no room session exists, or the room leaves the
waiting state. The waiting page remains a pure consumer of `room.members`.

Disconnects follow the existing domain model: the seat remains in the list
and changes to `connected=false`, so the UI displays the existing offline
label instead of removing it. The aggregate summary cannot identify which of
several remote members disconnected, so exact remote identity remains a
server-side broadcast responsibility.

## Tests

1. Pure frontend tests cover no-op matching summaries, player joins, player
   disconnects, spectator changes, and missing/non-waiting summaries.
2. A real Socket.IO regression verifies that a host-side summary probe and
   on-demand recovery changes the waiting-room projection from one player to
   two after join, then marks the remote seat offline after disconnect.
3. A real Vite + Socket.IO + Playwright verifier creates a host room, joins and
   disconnects a guest, asserts the rendered count and offline label update,
   and checks 390, 768, and 1440 pixel layouts for overflow, clipped controls,
   overlap, browser errors, and failed requests.

## Acceptance

The focused regression changes from red to green, the waiting-room browser
verifier passes at all three widths, and `typecheck`, `lint`, and `build`
remain green.
