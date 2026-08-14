# V3 Vote Round Projection Design

## Problem

The V3 game page derives exile vote candidates from the accumulated public
event stream. A Day 1 `day.revote_required` event can remain the latest vote
event while a Day 2 voting snapshot is already active, causing the old
restricted candidate set to leak into the new ordinary vote.

## Scope

This change is frontend-only. It does not change shared protocol fields,
server state, or server vote validation.

## Design

Add a pure `currentVoteRoundProjection` function in `src/v3/actions.ts`. Its
inputs are the current projected snapshot, accumulated visible events, and
the viewer's current `allowedActions`.

The projection:

- returns an inactive round when neither `vote` nor `abstain` is allowed;
- creates a stable round key from `gameId`, `day`, and `stageRevision`;
- treats `day.started` and `day.voting_started` as current-day/current-round
  boundaries;
- rebuilds an ordinary vote from all legal living targets in the current
  snapshot;
- narrows targets only when a `day.revote_required` event belongs to the
  current day and occurs after the current vote boundary;
- excludes the current player from vote targets.

`eligibleTargets('vote', ...)` delegates to this projection. `GamePage`
uses the projection key as the lifecycle boundary for target selection, so
an old selection, candidate restriction, and action draft are cleared
together when the authoritative round changes.

## Tests

1. A frontend state test reproduces Day 1 revote restricted to P09 followed
   by a Day 2 snapshot with `allowedActions = [vote, abstain]`. The expected
   Day 2 targets are every other living player, not only P09.
2. A real `GameSession + Socket.IO + Playwright` verifier drives a game
   through Day 1 revote and into Day 2 ordinary voting, asserts the rendered
   legal target set, and checks 390, 768, and 1440 pixel layouts for
   overflow, clipped controls, overlap, browser errors, and failed requests.

## Acceptance

The focused regression test changes from red to green, the full-game browser
verifier passes at all three widths, and `typecheck`, `lint`, and `build`
remain green.
