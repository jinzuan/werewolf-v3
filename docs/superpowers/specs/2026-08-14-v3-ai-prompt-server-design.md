# V3 AI Prompt Server Integration Design

## Scope

This change integrates the V3 prompt system into the new `server/ai` path only.
The legacy `shared/aiClient` and `RoomEngine` compatibility path remain
unchanged. Existing deterministic and legacy providers keep their current
behavior.

## Data Flow

`RoomService` selects an AI actor from the authoritative session state and
projects players and events for that actor. It passes the projection as the
optional `promptContext` field of `AIRequestContext`.

`PromptAIProvider` performs one logical AI turn:

1. `PromptBuilder` loads the global system fragment, one role fragment, one
   stage/action task, projected runtime facts, and server-generated rules.
2. The provider sends the resulting `{ system, user }` prompt to an injected
   completion client.
3. `OutputParser` converts the raw response to one `GameCommand`, validating
   action type and target against the service-provided legal set.
4. `RepeatPolicy` compares speech output with same-scene history. A collision
   causes one regeneration request containing a concise novelty instruction.
5. Only the final parsed command is returned to `AIOrchestrator`; dispatch
   remains single-shot and existing deterministic fallback handles failures.

## Components

### `server/ai/promptBuilder.ts`

The builder reads the existing Markdown templates from `src/ai-prompts/`,
extracts only fenced prompt fragments, renders all placeholders, and rejects
missing required rule/action/target data or unrendered placeholders. Empty
lists render as `无`. Role-private blocks are supplied only when the selected
role template requests them.

Rules are generated from the server-owned `RULESET`/`RULE_VALUES` data. Role
templates never decide rule values. The builder also creates the output
contract and legal target text from the current context.

### `server/ai/outputParser.ts`

The parser accepts JSON-like and line-oriented model output. It handles:
speech and wolf chat text, vote target plus optional reason, night skill
actions, wolf vote, hunter shot, and explicit skip actions. Names are matched
only against the legal target projection. Invalid or ambiguous output returns
an error result; it never emits a second command or mutates session state.

### `server/ai/repeatPolicy.ts`

History is keyed by game, player, phase, and stage. Text is normalized by
removing whitespace and punctuation, then compared using exact match,
containment, and character n-gram Jaccard similarity. Exact/near duplicate
speech or repeated same-scene output produces a collision with a bounded
novelty instruction. The policy does not dispatch or retry commands.

### `server/ai/promptProvider.ts`

This adapter implements the existing `AIProvider` interface using an injected
completion client. It allows one correction generation for a repeat collision
or parse failure, then throws so `AIOrchestrator` performs its existing
deterministic fallback. The adapter records accepted speech only after the
command has been parsed, so rejected output cannot pollute repeat history.

## Error Handling

- Missing rules, legal actions, legal targets, or unresolved placeholders:
  return the server-defined invalid-context response through the provider
  error path.
- Unsupported action, malformed output, unknown target, or ambiguous target:
  fail parsing without dispatch.
- Repeated speech:
  regenerate once with a novelty instruction; if still repeated, fall back.
- Provider timeout or any other provider error:
  preserve existing orchestrator timeout and deterministic fallback behavior.
- The orchestrator remains the only component that dispatches a command.

## Testing

Focused tests cover:

1. system + role + runtime facts + output contract assembly;
2. structured speech/vote/night parsing and illegal target rejection;
3. same-scene similarity and consecutive-repeat detection;
4. server rule injection, including wolf self-kill/empty-kill and witch notice
   visibility;
5. provider correction/fallback performs at most one final dispatch through the
   orchestrator.

The acceptance gate is `npm test`, `npm run typecheck`,
`npm run server:typecheck`, `npm run lint`, and `npm run build`.
