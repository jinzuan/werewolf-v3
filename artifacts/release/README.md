# Release gate receipt

The generated `release-gate.json` contains only safe verification facts:
commit, tool versions, fixture checksum, suite count, bundle byte count, and
the canary-scan status. It must never contain credentials, prompts, or
absolute sensitive paths.
