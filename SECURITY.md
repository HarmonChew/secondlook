# Security and privacy

Engine is a local trusted-host developer tool. It is not a security sandbox
for arbitrary repositories, model output, or hostile project code. Report
security issues privately before opening a public issue when possible.

## Runtime boundary

- The review API binds to `127.0.0.1` and uses a random bearer token stored in
  `<data-dir>/access-token` with restrictive permissions.
- API and artifact routes require the bearer token. Host and Origin are checked;
  cross-site privileged requests are rejected. The UI does not use a cookie;
  it transfers the startup fragment to session storage and removes the fragment
  from the visible URL.
- Artifact access takes an opaque artifact ID. The server resolves only an
  owned, recorded file and verifies metadata; callers cannot supply an
  arbitrary filesystem path.
- Static dashboard content is a separate public surface from the privileged
  API. The application under review is served from another loopback port and
  is not a trusted runtime client.

These controls reduce accidental local cross-origin access; they do not protect
against a fully compromised local account, malicious browser extension, or
hostile process running as the same user.

## Trusted host, not sandbox

Git worktrees provide checkout isolation and candidate reproducibility, not an
OS security boundary. A forced working directory, environment allowlist,
argument-array command, command log, or model-harness setting cannot contain
arbitrary code with host permissions. The Codex driver requests the harness
restrictions documented in [docs/agent-drivers.md](docs/agent-drivers.md), but
the actual safety guarantee is the provider/harness implementation and host
configuration.

The Pi AI driver uses a separately supervised worker with a fixed catalog of
providers. It passes only the selected provider's API-key environment reference
and has no credential store, ambient OAuth login, or user-supplied endpoint.
Its model tools list, read, and write bounded UTF-8 files within the approved
source scope. They reject traversal, symlinks, hard links, known sensitive
paths, dependencies, and generated outputs. Writes require the previous
content hash or explicit new-file creation. The model has no shell or general
network tool; the worker itself connects to the selected hosted model API.
These file checks are not a sandbox against hostile processes racing filesystem
changes. Engine remains responsible for installs, checks, and browser evidence.

Executable extensions loaded with `--trust-extension` are trusted host code.
Engine never executes newly discovered repository configuration automatically.
Only a maintainer who explicitly supplies both `--extension PATH` and
`--trust-extension` should load one. An extension can declare local helper or
configuration dependencies with `sourceFiles`; all such files must be declared
or bundled because Engine does not promise automatic import-graph discovery.
The entry and declared files are hashed, and changes invalidate the current
registry digest and require a restart/approval.

Treat repository files, issue text, external documents, model output, and tool
output as untrusted data. A request to modify an application does not authorize
destructive host operations, production changes, credential extraction, or
publication.

## Credentials and captured data

- Keep API keys and environment values out of requests, scenario JSON, Git,
  screenshots, videos, traces, and logs.
- Use `envRefs` and `headersRefs` as names of existing environment variables;
  Engine stores references and digests, not ordinary credential values.
- Process logs redact explicit environment references, scenario header values,
  and values read from approved browser auth state. Credential-like values
  shorter than four characters are rejected rather than logged as safely
  redacted. This is not blanket redaction for arbitrary baseline/inherited
  variables.
- Browser authentication state is read only from `<data-dir>/auth/<id>.json`,
  must be a user-owned regular file, and must not be group/world readable.
- Use dedicated test identities and a non-production backend. The runtime does
  not claim to redact every secret from a screenshot, video, or Playwright
  trace. Review captured artifacts before sharing them.
- A hosted model may receive repository content when the selected provider
  does so. “Local service” does not mean all source processing stays local.

Source fingerprints include relevant ignored/untracked source files and
executable bits, while excluding `.env*`, PEM, and key contents. Changed or
newly untracked sensitive files block a run. Ancestor symlinks are rejected.
Root-level generated directories are excluded by policy; a source path such as
`src/runtime` is not excluded merely because it contains the word runtime.

Dependency integrity is separate from source fingerprinting. The approved
manifest covers `node_modules` files, modes, contained symlink targets, and
missing/present directories, excluding direct `.vite`, `.vite-temp`, and
`.cache` tooling caches. Agent or manual dependency edits block and invalidate
the review while preserving files; Engine does not silently reinstall, delete,
or adopt an unknown dependency tree. Restore a known installation or start a
fresh approved run. Scanning cost grows with dependency-tree size.

Large artifacts and logs are stored under the data directory. The dashboard
escapes rendered request text, logs, diffs, and model summaries, but a reviewer
should still treat downloaded files as untrusted content.

## Workspaces and cleanup

The data directory must be outside the normal target checkout. Engine creates
baseline/candidate worktrees below it and records signed ownership markers.
Cleanup checks exact repository/worktree ownership and clean status; it refuses
dirty paths and ignored-untracked files (including `node_modules` and `.env`),
and preserves uncommitted manual work. Partial cleanup remains blocked with
snapshots/diffs and data preserved; there is no uncertain-path auto-deletion.
Never change a database path and then recursively delete the resulting path.
Inspect `git worktree list` and the recorded marker when reconciling an
interrupted operation.

Evidence is bound to the verification runtime source and lock version. After a
runtime upgrade, re-run verification before accepting existing evidence.

## Reporting

Please include the Engine version, operating system, Node version, reproduction
steps, and whether the Codex driver, Pi provider, or a trusted extension was enabled. Remove
tokens, source code, authentication state, and captured secrets from reports.
Do not attach `access-token`, `.env*`, auth JSON, raw model prompts, or unreviewed
screenshots/traces/videos.

This MVP was exercised locally only on macOS. Linux/WSL2 are target/CI paths and
were not run locally here.

Until a release-specific security contact is published, open a private GitHub
security advisory for the repository owner or contact the maintainer listed in
the project metadata. For ordinary bugs, use the contribution process in
[`CONTRIBUTING.md`](CONTRIBUTING.md).
