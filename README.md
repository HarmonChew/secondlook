# Engine — local AI change review

Engine is a local-first review loop for changes made by a coding agent. It
keeps an approved request, project profile, and Playwright scenario together;
creates isolated Git worktrees; captures real baseline/candidate evidence; and
gives a reviewer a candidate they can open, reset, inspect, and accept.

The dashboard is deliberately a review queue rather than an autonomous
deployment system. Acceptance records that a particular candidate revision was
reviewed. It does not commit, push, merge, publish, or deploy anything.

## MVP status

The repository contains one complete vertical slice:

```text
approved ticket + scenario
  -> external baseline/candidate worktrees
  -> baseline evidence (bug fixes only)
  -> deterministic demo, Codex SDK, or Pi AI provider adapter
  -> candidate browser evidence and project checks
  -> dashboard review, preview/reset, feedback, acceptance
```

The included profile fixture proves a real failing baseline and a real passing
candidate. It uses a local in-memory test backend and a deterministic fake
driver; it is intentionally not evidence about a production backend.

## Requirements and support boundary

- Node.js 22.19 through 24 (the tested default is Node 22).
- pnpm 11.
- Git on `PATH`.
- Chromium installed for Playwright.
- macOS is the only platform exercised locally for this MVP. Linux and Windows
  through WSL2 are target/CI platforms, but were not run locally here; native
  Windows process lifecycle support is not claimed.

The runtime currently supports a single managed HTTP application service and
argument-array commands from an approved profile. The documented frontend
boundary is a Vite-style frontend (the included fixture is a tiny Node HTTP
application). This is not universal monorepo, backend/database cloning, or
framework autodetection.

## Install

From this repository:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
```

On a Debian/Ubuntu CI or development machine where browser system packages are
missing, use:

```bash
pnpm exec playwright install --with-deps chromium
```

The installation command may compile the maintained `better-sqlite3` binding.
The package manager build allowlist is in `pnpm-workspace.yaml`.

## Start the review service

Use the foreground service with a data directory outside the target checkout:

```bash
pnpm start --data-dir /tmp/engine-review-data
```

The default data directory is:

```text
~/.local/state/engine-review
```

The service binds to `127.0.0.1` only. It prints a dashboard URL and the exact
token file path. The token is stored as a 0600 file at
`<data-dir>/access-token`. Open the printed URL, or enter that token in the
dashboard when prompted. `--open` opens the URL in the system browser:

```bash
pnpm start --data-dir /tmp/engine-review-data --open
```

For frontend iteration, use Vite middleware:

```bash
pnpm dev --data-dir /tmp/engine-review-data
```

The service remains in the foreground. `Ctrl+C` stops processes owned by the
service and closes the SQLite store.

## Run the self-contained demo

The demo needs no paid model account or private service:

```bash
pnpm demo --data-dir /tmp/engine-review-demo --open
```

The command automatically queues one bug-fix demo. Open its ticket in the
dashboard to review the profile persistence bug. The baseline actually performs:

```text
enter Taylor Demo -> save -> see “Saved successfully” -> reload -> old name
```

The candidate driver changes the fixture, and the same approved actions run
again. The review should show `Regression reproduced` on the baseline and
`Targeted scenario passed on candidate` for the candidate. Screenshots,
Playwright traces, service logs, action results, and assertion results are
created by execution and stored as protected artifacts.

To try the feedback loop, open the bug-fix ticket, choose `Request changes`,
enter exactly `Change the save button label to Save profile`, leave the Profile
persistence scenario selected, and submit. The deterministic demo driver applies
that supplied correction and reruns the actual verification. It supports this
known correction only; arbitrary natural-language changes require the real Codex
driver or a custom driver and may block in demo mode.

The feature demo is after-only:

```bash
pnpm demo --feature --data-dir /tmp/engine-review-feature --open
```

It exercises populated, empty, and API-error organization-unit states using
approved simulated responses. The dashboard labels those scenarios `Simulated
API`; it does not claim to test a production API.

The demo repository is created under the selected data directory at
`projects/profile-fixture`. It is a tool-owned fixture repository. Your normal
checkout is not used as the demo workspace and is not modified.

## Create a real ticket

In the dashboard choose “New ticket”. Supply:

- a title and natural-language request;
- `bugfix` or `feature`;
- the absolute path of an existing Git checkout and its base ref;
- an approved project profile JSON document;
- one or more approved scenario JSON documents;
- the selected driver (`codex` or `pi` for real models, or `demo` only for the
  explicitly marked fixture demo), plus a provider and model when using Pi; and
- an explicit policy, including required checks, repair limit, and operations
  that require human approval.

The advanced fields are intentionally visible JSON. The runtime validates them
with Zod before queuing a run. Scenarios and expectations are persisted as
approved run data; the implementation agent has no normal tool that can edit
them. An agent may suggest scenarios in a future integration, but suggestions
must be reviewed and approved before execution.

Starter documents are in [`examples/`](examples/):

- [`vite-profile.json`](examples/vite-profile.json) — a Vite-oriented profile
  to adapt to a project’s actual scripts.
- [`vite-scenario.json`](examples/vite-scenario.json) — a form scenario with
  explicit selectors and a reset recipe.
- [`erp-staff-profile.json`](examples/erp-staff-profile.json) — an illustrative
  profile for the Staff application discussed during design. It is not an
  executed integration and must be adapted to the approved local startup,
  health, auth, fixture, and reset mechanisms of that checkout.

The approved project profile controls installation, startup, health checks,
verification commands, browser base URL, viewports, environment-variable
references, authentication-state references, and source inclusion/exclusion.
Commands are arrays of executable plus arguments. Model text is never
interpolated into a shell command.

Browser execution is same-origin by design: the reviewed frontend may call its
own origin (including an approved same-origin backend proxy), but direct
cross-origin API calls are blocked by the managed browser context. Configure a
test proxy or approved local gateway when the frontend normally talks to a
separate service.

## What the dashboard shows

The board groups tickets into Queued, Working, Needs attention, Ready for
review, and Accepted. A ticket detail page provides:

- the current workflow phase and candidate snapshot/source digest;
- scenario cards with before/after evidence for bug fixes and after-only
  evidence for features;
- exact action results, assertion outcomes, screenshots, video when available,
  traces, and protected logs;
- separate command/check results and a list of untested, simulated, blocked, or
  uncertain behavior;
- Activity events and stage attempts;
- a read-only candidate diff; and
- `Open candidate`, `Reset scenario`, `Request changes`, `Pause safely`,
  `Resume`, and `Accept behavior` controls.

The interactive candidate uses a managed headed Playwright context with the
approved route, viewport, request mocks, identity references, and fixture reset
recipe. It is not an ordinary browser tab and it does not reuse the developer’s
browser profile. Automated verification uses a separate context.

The UI does not collapse everything into a universal “Verified” badge. In
particular:

- a baseline assertion failure is `Regression reproduced` only when the named
  regression assertion actually failed;
- a passing baseline is `Original failure not reproduced`;
- application startup/browser setup failures are `Environment blocked`;
- missing results are `Not tested`;
- changes after verification are `Evidence stale`; and
- agent summaries are commentary, not verification.

## Feedback, repair, pause, and recovery

`Request changes` attaches short feedback to an approved scenario and optional
action/capture point. It creates a new implementation attempt on the current
candidate, invalidates the prior acceptance, and reruns required verification.
The default automatic implementation repair limit is one (configurable from
zero through three). Infrastructure retries are separate and never become
coding repairs.

`Pause safely` waits for the active writer and owned processes to quiesce before
reporting that the candidate is safe to edit. On resume, Engine fingerprints
relevant source files, preserves manual edits, creates a new candidate snapshot,
and marks old evidence/acceptance stale. It never resets manual edits just to
retry.

SQLite operational state, append-only activity events, attempts, snapshots,
artifact metadata, process identities, and incomplete filesystem operations are
kept under the data directory. Large artifacts and logs are files with hashes
in SQLite. On restart, interrupted implementation work is blocked and checked
without blindly replaying the missing model conversation. Run recovery is
explicit: inspect the activity and resume when appropriate.

The source fingerprint also binds relevant ignored-but-source untracked files
and executable bits. Root-level generated/runtime directories are excluded by
policy, while source paths such as `src/runtime` remain eligible. `.env*`, PEM,
and key contents never enter the fingerprint or diff; a changed or newly
untracked sensitive file instead blocks the run and must be supplied through an
approved environment reference. Ancestor symlinks are rejected. A runtime
upgrade changes the verification-runtime digest (Engine source plus lockfile),
so existing evidence must be reverified before acceptance.

If the relevant source digest or package/configuration manifest/lock inputs
change, installation is refreshed with the approved commands. Each setup
command is journaled and may be approval-gated; an interrupted command with
unknown effects blocks instead of being replayed blindly. Existing dependency
state is checked before reinstalling, so a hidden dependency edit cannot become
approved merely because installation exits successfully.

Dependency integrity is separate from the source digest. Engine records a
SHA-256 manifest of `node_modules` files, executable modes, contained symlink
targets, and missing/present scanned directories; direct `.vite`, `.vite-temp`,
and `.cache` tooling caches are excluded. Agent or manual dependency edits
block the run, invalidate affected evidence/acceptance, and preserve the files.
There is no silent reinstall, deletion, or adoption of an unknown dependency
tree: restore the known installation or start a fresh approved run. The scan
cost grows with dependency-tree size. The source runtime must not import an
excluded tooling cache.

The supported frontend boundary is a Vite/pnpm-style project. Profiles should
run tracked source, or regenerate excluded `dist`, `runtime`, or `build`
outputs through approved startup/setup commands. Directly serving mutable
excluded outputs is not supported or verified.

Cleanup requires an exact run ID and refuses unowned, non-Git, missing-marker,
dirty, or ignored-untracked worktrees (including `node_modules` and `.env`
files). Dirty or ignored-untracked worktrees are preserved by default. If a
cleanup operation is only partially observed, Engine blocks conservatively and
preserves the recorded snapshot/diff and data rather than auto-deleting paths:

```bash
pnpm exec tsx src/cli.ts cleanup --run RUN_ID --data-dir /tmp/engine-review-demo
```

## Real Codex integration

The real driver is an adapter around the supported TypeScript Codex SDK, kept
behind the `AgentDriver` interface. It runs a separately supervised worker with
the candidate workspace as its working directory, `workspace-write` sandbox
mode, approval policy `never`, network access disabled, and a private
`CODEX_HOME` staging directory. The driver records structured agent results
and reliable token usage only when the SDK supplies it.

To use it, provide the credential through the existing supported environment
mechanism before starting the service:

```bash
export CODEX_API_KEY='...'
pnpm start --data-dir /tmp/engine-review-real
```

No real-model call is made by the normal demo or test suite. Without the key,
the Codex run is blocked with a credential reason before starting a model
worker. Do not put credentials in profiles, scenario JSON, issue text, Git, or
ordinary artifacts. A hosted model receives repository content when the
selected integration sends it; local orchestration does not mean hosted-model
processing is local.

The SDK adapter is implemented, but no paid/live provider call has been
performed as part of MVP validation. Provider behavior requiring a live
credential is intentionally not exercised in this repository’s default tests.
See [docs/agent-drivers.md](docs/agent-drivers.md).

## Multiple model providers with Pi AI

Choose **Pi AI (multiple providers)** in a new ticket, then choose a provider
and model. Engine uses the pinned `@earendil-works/pi-ai` catalog for OpenAI,
Anthropic, Google, OpenRouter, Groq, Mistral, and xAI. The selection is saved with
the ticket and reused for repairs. Codex remains the default driver.

Set the selected provider's API key in the service environment before starting
Engine; for example, Anthropic uses `ANTHROPIC_API_KEY`, Google uses
`GEMINI_API_KEY`, and OpenAI uses `OPENAI_API_KEY`. The form shows the exact
variable required and whether it is configured. A configured key does not prove
access to every model in the catalog. Keys never go in ticket JSON or the UI.

The Pi worker can list, read, and write approved candidate source files. It
uses bounded tool calls, checks content hashes before overwriting files, and
blocks sensitive paths, symlinks, dependencies, and generated directories.
Engine runs installation, commands, and browser verification after the edits.
This first adapter has no shell, delete, or rename tool, and supports API keys
only; OAuth, local models, and custom endpoints are not configured here.

Model calls send task data and inspected source to the selected provider.
The default tests use fake model responses; no live or paid provider call has
been used to validate this integration. See
[the driver guide](docs/agent-drivers.md#pi-ai-adapter) for API selection,
credential names, and execution limits.

## Add a custom verification check

Executable extensions are trusted code. They are not a sandbox. Load one only
with an explicit command-line approval:

```bash
pnpm start \
  --data-dir /tmp/engine-review-custom \
  --extension ./examples/custom-check.ts \
  --trust-extension
```

The included [`examples/custom-check.ts`](examples/custom-check.ts) reads the
candidate’s `index.html` and checks for a non-empty `lang` attribute. It is an
actual deterministic check from outside core source. To require it, include
`html-language` in the ticket policy’s `requiredCheckIds`. The extension entry
file is hashed at load time. An extension may declare local helper/configuration
files with `sourceFiles`; every helper or configuration file must be declared or
bundled. Engine hashes the declared local/transitive dependency files, but does
not promise to discover an import graph automatically. Changing any declared
source makes current evidence stale and requires a restart plus explicit
approval of the new version.

See [docs/customization.md](docs/customization.md) for the TypeScript
interfaces and driver/scenario extension boundaries.

## Test and build

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:browser
```

Tests use deterministic fake drivers and the local fixture. They do not require
paid model credentials. Browser tests use Playwright Chromium and may require
the install command above. The default test suite is the source of truth for
what has been exercised; no live Codex smoke test is implied.

## Security and privacy at a glance

The local API listens only on loopback, validates the Host and Origin, rejects
cross-site privileged requests, requires a bearer token, and protects artifact
downloads. The UI stores the token in session storage and does not use a cookie;
the startup URL’s fragment is removed from browser history after handoff.

This is trusted-host mode, not a hostile-code sandbox. Git worktrees provide
checkout separation, not OS isolation. Approved commands and Codex SDK tools
still execute with host permissions within the limits documented by the
selected harness. Use dedicated test identities and separate browser auth
state. Screenshots, video, and traces cannot be promised to redact every
secret, so do not use real credentials in captured scenarios.

Read [SECURITY.md](SECURITY.md) before connecting a real project and
[docs/recovery.md](docs/recovery.md) for incomplete operations and cleanup.

## Known gaps and deferred scope

- No automatic merge, publication, PR creation, deployment, or production-data
  mutation.
- No universal monorepo, backend clone, database snapshot, SSO automation, or
  remote runner.
- One active implementation execution and one automated browser session are
  supported at a time.
- The included feature API states are approved simulated responses, not proof
  of authorization or production persistence.
- The ERP Staff profile is a starting point only; the real repository’s
  environment, authentication, test data, and reset contract must be approved
  and validated before use.
- Native Windows support, streamed desktops, visual similarity scoring, and
  model-conversation resumption are out of scope for this MVP.

See [docs/architecture.md](docs/architecture.md) for the state and artifact
model, and [CONTRIBUTING.md](CONTRIBUTING.md) for contributor workflow.

## License

New code in this repository is Apache-2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE). Third-party dependencies remain under their own licenses.
