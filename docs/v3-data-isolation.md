# V3 server data isolation

The room and event JSON files are controlled repository state. Do not edit,
replace, or delete them by hand, and do not point a test or E2E process at a
production data directory.

Production requires explicit `WW_DATA_DIR` and `WW_DEPLOYMENT_NAMESPACE`.
Test/E2E processes must use a fresh temporary `WW_DATA_DIR`; development
defaults to `.data/dev/<namespace>`. Every file carries its environment and
deployment namespace, and a mismatch is rejected rather than merged.

Use the repository/service or the controlled administrative CLI for cleanup:

```text
tsx scripts/admin/rooms.ts list-expired --data-dir /absolute/tmp/ww --namespace e2e
tsx scripts/admin/rooms.ts sweep --data-dir /absolute/tmp/ww --namespace e2e
tsx scripts/admin/rooms.ts remove --room-code ABC123 --data-dir /absolute/tmp/ww --namespace e2e
```

The CLI uses the same lock and atomic-write path as the running server. Its
output is intended for audit logs and never includes room credentials.
