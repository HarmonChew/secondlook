# Architecture and state model

Engine is a single foreground Node service. The service owns authoritative
writes; the React dashboard is an authenticated client of its loopback API.

```text
React/Vite dashboard
        |
        | bearer-authenticated HTTP
        v
Engine workflow coordinator
  |         |             |
SQLite   Git worktrees  Playwright
state    + processes     evidence
  |
artifact files, logs, traces, screenshots, videos
```

## Run state

Each run stores the request, `bugfix`/`feature` kind, repository identity and
base commit, approved profile and scenarios, policy, driver ID, workspace
identities, source snapshots, review revision, repair count, feedback IDs,
acceptance decision, and stale/blocked state.

Workflow phase and execution status are separate:

```text
PREPARE
  -> CAPTURE_BASELINE       (bugfix only)
  -> IMPLEMENT
  -> VERIFY_CANDIDATE
  -> READY_FOR_REVIEW
```

Status values include `queued`, `running`, `blocked`, `paused`, `failed`,
`complete`, and `cancelled`. A blocked status carries a reason. Environment
failures do not become implementation repairs. A bounded repair is only
considered after actionable candidate behavior/check failure.

The default policy permits one automatic implementation repair, one
infrastructure retry, and no approval gates. Profiles can require human
approval before install, implementation, verification, or interactive preview.

## Workspaces

The normal target checkout is resolved to a Git repository and pinned to the
selected base commit before any worktree is created. Worktrees live below the
Engine data directory, not below the target checkout:

- bug fixes get a detached baseline worktree at the base commit and a candidate
  worktree on `engine/<run-id>`;
- features get only the candidate worktree on that branch.

Each workspace has an ownership marker signed by a data-directory key. Cleanup
checks the marker, Git worktree membership, exact repository, exact base commit,
candidate branch, and clean status before removing anything. It will not
recursively delete a path just because a database row names it. Dirty or
ignored-untracked content (including `node_modules` and `.env` files) also
blocks cleanup. If cleanup is only partially observed, the operation remains
blocked and the snapshot/diff and data are retained; there is no automatic
recursive deletion recovery.

Dependency directories are not copied or shared as mutable worktree content.
Installation is an approved profile command, and relevant source changes caused
by setup are detected before evidence is accepted.

Installation commands have an intent journal. On recovery, commands already
recorded as successful are skipped. If the relevant source digest or
manifest/lock inputs change, the candidate is refreshed with the approved
installation commands, subject to the profile’s approval gate. This includes
configuration and local package-source inputs outside a short list of known
filenames. Before reinstalling, the existing dependency tree is checked so a
hidden dependency edit cannot become approved merely because installation exits
successfully. An interrupted command whose outcome is unknown is not replayed
automatically: the run blocks so the maintainer can inspect the
worktree or start a fresh approved run. A journal records intended and observed
operations; it does not make Git, filesystem, package-manager, and child-process
effects atomic.

## Dependency integrity

Dependency integrity is tracked separately from the source fingerprint. An
approved setup records a SHA-256 manifest over the workspace’s `node_modules`
files, executable modes, contained symlink targets, and the presence/absence of
scanned directories. Direct tooling caches under `node_modules/.vite`,
`node_modules/.vite-temp`, and `node_modules/.cache` are excluded. The source
runtime must not import or depend on those excluded tool caches.

Agent or manual dependency edits block the run, invalidate acceptance and
affected evidence, and preserve the files for inspection. Engine does not
silently reinstall, delete, or adopt an unknown dependency tree. Restore a
known approved installation or create a fresh run. Integrity scans grow in cost
with the size of the dependency tree, which is an intentional tradeoff for
detecting mutable dependency state.

The supported frontend boundary is a Vite/pnpm-style project. Profiles should
run tracked source, or regenerate excluded `dist`, `runtime`, or `build`
outputs through approved startup/setup commands. Directly serving mutable
excluded outputs is not supported or verified.

## Fingerprints and evidence context

The source fingerprint is a SHA-256 digest over approved tracked and relevant
ignored/untracked source paths. It includes executable bits. The inclusion
policy comes from `profile.source.include` and `exclude`, with hard exclusions
for Git metadata, `.env*`, `node_modules`, and generated directories at the
repository root such as `runtime`, `dist`, `coverage`, `artifacts`, and
`test-results`; a source path such as `src/runtime` is not excluded merely by
name. Deleted tracked files are represented explicitly. Ancestor symlinks are
rejected. `.env*`, PEM, and key contents never enter the fingerprint or diff,
but changed or newly untracked sensitive files block the run and must be
provided through approved environment references.

Every evidence/check artifact records a context containing:

- candidate workspace ID, base commit, snapshot ID, and source digest;
- scenario ID, revision, and scenario digest;
- approved profile digest;
- verification-check digest; and
- environment digest (Node/platform/browser versions, referenced environment
  values as digests, referenced auth-state files as digests, runtime source and
  lock version, and the recorded dependency-integrity digest for that
  workspace). Baseline and candidate therefore bind to their respective
  dependency environments.

Evidence is valid only when its file and artifact references resolve in the
same run and its context matches the displayed candidate and approved inputs.
Schema validation is necessary but is not treated as proof that execution
actually happened.

## SQLite and files

`better-sqlite3` stores current operational records plus an append-only activity
history. The store uses a versioned migration, WAL mode, foreign keys, and
short writes. Tables cover runs, events, stage attempts, snapshots, artifacts,
filesystem operations, and managed processes.

Large payloads are files under the data directory. The SQLite row stores a
relative owned path, media type, size, and SHA-256. Publication uses a temporary
file and atomic rename. Startup reconciliation quarantines unreferenced or
partial artifact files rather than serving arbitrary paths. Artifact API routes
resolve an artifact ID, not a caller-provided filesystem path.

## Process ownership

Commands are executable plus argument arrays with a profile-controlled working
directory and environment references. They are not shell strings assembled from
model text. A detached supervisor records a process token, PID, start identity,
arguments, working directory, and log path before the target starts. Graceful
termination is followed by escalation; process-group cleanup is guarded by the
recorded identity and token so a reused PID is not killed. Only one managed
process is active at a time in this MVP.

The service owns readiness polling, timeout, port selection, and shutdown. A
port conflict blocks the run; it never kills an unrelated process occupying the
requested port.

Process logs redact explicitly referenced environment values, scenario header
values, and values read from approved browser auth state. Credential-like
values shorter than four characters are rejected rather than logged as if they
were safely redacted. This is not blanket redaction of arbitrary inherited
environment variables, screenshots, videos, or full Playwright traces.

## Browser contexts

Automated verification and human preview use separate Playwright contexts. Both
apply the approved viewport, route, request mocks, session header/auth
references, and reset recipe. Verification captures action results plus
screenshots, trace, and video where configured/available. An interactive preview
is headed by default and opens the real candidate service in a managed browser;
it is not an ordinary user-profile tab or a privileged iframe.

## Restart and acceptance

At startup, unfinished attempts are marked interrupted. A run that was writing
implementation code is blocked and moved to candidate verification rather than
blindly replaying the missing model conversation. Filesystem/process operations
are inspected from their intent/result records; reconciliation is conservative
and does not claim that every external effect can be automatically reconstructed.

Evidence contexts include a digest of the verification runtime source and lock
version. Restarting with an upgraded Engine/runtime invalidates the prior
verification context; reverify before accepting the candidate.

Acceptance requires the exact candidate snapshot, review revision, fresh current
candidate evidence for every approved scenario, comparable bug-fix baseline
evidence when applicable, and fresh required checks. The decision artifact
records its inputs and `publication: none`. Any scenario/profile/check/source/
extension change invalidates prior acceptance.
