# Windows Persistence EPERM Recovery Design

## Scope

Fix all server-side JSON persistence paths that replace a destination file with
`rename`:

- `server/rooms/fileRepository.ts`
- `server/events/fileStore.ts`
- `server/persistence.ts`

The runtime must continue serving commands when Windows temporarily locks a
destination file or when persistence ultimately fails.

## Considered Approaches

1. Retry `rename` only. This addresses transient locks but still surfaces an
   exception when antivirus or another process holds the file longer.
2. Retry `rename`, then copy the completed temp file over the destination and
   delete the temp file. This keeps the normal atomic path and provides a
   Windows-compatible fallback.
3. Write directly to the destination after failure. This avoids replacement
   errors but can expose partial JSON and violates the existing atomic-write
   invariant.

Use approach 2. It preserves temp-first writes, handles common Windows lock
windows, and never writes partially serialized data directly during the normal
path.

## File Replacement Module

Add a small server persistence helper with async and sync variants:

1. Write the full value to a uniquely named temp file beside the destination.
2. Attempt `rename` up to four times total.
3. Retry only `EPERM` with short bounded backoff.
4. If all `EPERM` attempts fail, copy the completed temp file over the
   destination and delete the temp file.
5. On final failure, delete the temp file when possible, log the destination
   and error, and return a failure result instead of throwing.
6. Non-`EPERM` rename failures proceed directly to the copy fallback because
   retrying them is not expected to help.

The filesystem operations and sleep function are injectable so tests can
deterministically simulate Windows errors without relying on real file locks.

## Runtime State

`FileRoomRepository` and `FileEventStore` load their persisted JSON once into
an in-memory mirror. Initialization is lazy and serialized through their
existing operation queues.

Mutations update a cloned candidate state, attempt persistence, and then keep
that candidate in memory regardless of persistence success. Consequently:

- persistence failure does not reject a room command or event append;
- later reads in the same process observe the latest in-memory state;
- a new repository instance sees only the last successfully persisted state;
- `EventVersionConflictError` and other business validation errors still
  reject normally.

Malformed or missing files initialize an empty mirror, matching current
behavior.

The legacy synchronous persistence module uses the same retry/fallback policy.
Its public `serverStorage.set` already isolates failures; the shared helper
makes the Windows behavior consistent and retains temp-first writes.

## Logging

Final persistence failures emit one structured `console.error` entry with the
destination path and error. Transient retries do not log individually to avoid
noise. Repositories accept an injectable logger for deterministic tests.

## Tests

Add focused tests that inject filesystem operations:

- `rename` returns `EPERM` before succeeding: verify retry count and persisted
  content.
- `rename` exhausts `EPERM` retries: verify copy plus temp deletion fallback.
- both rename and copy fail: verify no exception escapes, an error is logged,
  and the temp file cleanup is attempted.
- room repository final failure: verify save resolves and the latest room is
  readable from the same instance.
- room repository restart after final failure: verify a new instance reads the
  last successful disk state.
- event store final failure: verify append resolves, subsequent reads include
  the event, and version conflicts still reject.

After focused tests, run the complete test suite, root and server typechecks,
lint, and build.
