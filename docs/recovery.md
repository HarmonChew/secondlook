# Recovery, pause, and cleanup

Engine is a foreground local service. It is designed to reconstruct durable
state after a process disappears, not to resume an exact model conversation.

## Restart

Run the same command with the same data directory. SQLite migrations run before
the service accepts requests. On startup Engine:

- marks active stage attempts as `interrupted`;
- inspects pending filesystem/process operations and install journal entries;
- quarantines partial/unreferenced artifact files;
- marks a previously active implementation run `blocked`; and
- moves an interrupted implementation to candidate verification so a missing
  agent turn is not blindly replayed.

The dashboard’s Activity tab shows the durable events and stage attempts. Resume
is an explicit user action. If a process died unexpectedly, inspect its log and
the candidate before resuming.

Installation recovery is deliberately conservative. A known-successful setup
command may be skipped. If an install command was interrupted and its outcome is
unknown, Engine blocks the run instead of replaying it blindly; inspect the
candidate/package state and either approve a safe continuation or create a fresh
run. Filesystem and process intent records help reconciliation, but they do not
make external side effects atomic or guarantee complete automatic recovery.

Relevant source/configuration or manifest/lock changes can trigger a refreshed
approved setup. Before that refresh, the existing dependency tree is checked;
an install exit code cannot silently bless a hidden dependency edit.

Dependency integrity is checked separately from source. The approved manifest
covers `node_modules` files, modes, contained symlink targets, and
missing/present directories, while excluding direct `.vite`, `.vite-temp`, and
`.cache` tooling caches. Agent or manual dependency edits block and invalidate
the candidate; files are preserved for inspection. There is no silent reinstall,
delete, or adoption of an unknown tree. Restore the known installation or start
a fresh approved run. Large dependency trees make this scan proportionally more
expensive.

## Pause and manual edits

`Pause safely` aborts the active writer, waits for its supervisor and owned
processes to quiesce, and only then reports that editing is safe. A paused
candidate can be inspected or edited by hand. Resume fingerprints the approved
source set, preserves edits, creates a new candidate snapshot/review revision,
and invalidates acceptance and affected evidence. It will not reset a candidate
to make a retry easier.

Changes made outside the approved source set may not affect the fingerprint,
but generated/runtime directories are intentionally excluded. Do not treat this
as a universal filesystem audit.

## Cancellation and infrastructure failures

Cancellation stops owned process groups with identity/token checks and records a
cancelled run. A process start identity is a `ps(1)` rendering taken under a
pinned locale and timezone, so it never depends on the service's own
environment; a process recorded by an older Engine build can therefore be
reported `unknown` once after an upgrade, which is the conservative outcome. A
browser/server startup failure produces environment/error evidence and is not
treated as the application reproducing the reported bug. Infrastructure retries
are bounded by `policy.infrastructureRetries` and do not consume the
implementation repair budget.

## Cleanup

Cleanup is explicit and exact:

```bash
pnpm exec tsx src/cli.ts cleanup \
  --run RUN_ID \
  --data-dir /path/to/the/same/data-directory
```

The command refuses queued/running runs, invalid ownership markers, paths that
are not the expected Git worktrees, dirty candidate/baseline worktrees, and
ignored-untracked content such as `node_modules` or `.env` files. A dirty or
ignored-untracked worktree is preserved so manual work is not lost. If cleanup
is only partially observed, recovery remains blocked and the stored snapshot,
diff, artifacts, and data are retained; Engine does not auto-delete uncertain
paths. Run records and artifacts remain even after clean worktrees are removed.

Never recursively remove the data directory or a repository as a cleanup
shortcut. If an operation is shown as `needs-reconciliation`, inspect the exact
paths and Git worktree list before taking any manual action.
