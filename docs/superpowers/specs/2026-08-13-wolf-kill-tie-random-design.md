# Wolf Kill Tie Random Resolution

## Decision

When the werewolf kill vote has multiple highest-vote targets, the core
immediately locks one of those tied targets using an injectable random number
generator. The vote does not return to discussion, request another vote, or
become an empty kill.

An all-abstain wolf vote remains an explicit empty kill because it has no tied
highest-vote target.

## Core Interface

`resolveWolfVote` accepts `rng: () => number`, defaulting to `Math.random`.
Tied leaders are sorted by the existing tally function, and the RNG value is
mapped to an index in that stable list. The mapping clamps out-of-contract RNG
values so an injected test double cannot select outside the tied set.

The core removes wolf-revote-only state and results:

- `wolfVoteRound`
- `wolfKillCandidates`
- `requestWolfRevote`
- `WolfVoteResult.revote_required`

Daytime exile revoting remains unchanged.

## Session And Contract

`GameSession` stores an optional RNG dependency and passes it to
`resolveWolfVote`. Once all living wolves have voted, the session always locks
the resolved target and advances directly to the witch stage.

The obsolete `wolf.revote_required` domain event and presentation branch are
removed from the shared contract and UI event formatter.

## Verification

- Core tests inject boundary RNG values and verify every result belongs to the
  tied leaders.
- Repeated deterministic runs cover every member of the tied set.
- Session tests inject RNG values and verify a tied vote advances directly to
  the witch stage with a non-null tied target.
- Existing daytime exile tie tests remain unchanged.
- Full test, typecheck, lint, and build commands must pass.
