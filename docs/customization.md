# Customization

The built-in workflow uses the same typed extension boundaries exposed to
projects. Configuration is ordinary TypeScript/JSON; there is no visual
workflow editor or general graph language.

## Project profiles

An approved `ProjectProfile` contains:

```ts
type ProjectProfile = {
  schemaVersion: 1;
  id: string;
  name: string;
  install: Command[];
  service: Command & {
    healthPath: string;
    startupTimeoutMs: number;
    fixedPort?: number;
  };
  baseURL: string; // loopback URL containing {{port}}
  checks: Array<{ id: string; name: string; required: boolean; command: Command }>;
  source: { include: string[]; exclude: string[] };
};
```

`Command` is `{ command, args, cwd, timeoutMs, envRefs }`. `envRefs` maps a
process environment name to an existing host environment name; values are not
stored in the profile. `cwd` is resolved beneath the selected worktree. The
runtime accepts loopback HTTP service URLs only for its managed application.

The profile is approved at run creation and its digest is part of every
verification context. Editing the profile after verification makes evidence
stale. Auto-detection, if added by a host application, must produce a proposal
that a human approves; this MVP does not execute repository configuration just
because it was discovered.

The managed browser allows same-origin application requests only. A frontend
that normally calls a separate API must use an approved same-origin development
proxy or local gateway in the project profile; direct cross-origin requests are
blocked by the evidence context.

The initial supported frontend boundary is Vite with pnpm-style profile
commands. Profiles must run tracked source or regenerate excluded `dist`,
`runtime`, and `build` outputs during approved startup/setup. Directly serving
mutable excluded outputs is not supported or verified, and the implementation
driver must leave dependency installation to the runtime.

## Scenarios

`ScenarioDefinition` identifies a stable ID, revision, route, viewport, optional
identity reference, fixture mode, reset endpoint/body, header references, mock
responses, setup actions, expected actions, and optional regression assertion.
Actions are a small approved set: `fill`, `click`, `reload`, `capture`, and
`assert` (`text`, `value`, `visible`, or `count`). Expected assertions have an
explicit `role`; a bug-fix regression assertion is named by ID.

The scenario is a review input, not an implementation output. Store it in the
ticket payload or another approved system outside the candidate source tree.
When a scenario changes, increment its revision and use the dashboard’s revised
scenario action. Secondlook recaptures a bug-fix baseline and invalidates the old
comparison. Manual source edits continue to use the original approved baseline
until the scenario itself changes. A feature run has no baseline; its UI
intentionally displays after-only evidence and `Baseline not applicable`.

Reset must be a documented test-fixture operation. Clearing cookies does not
reset server state. Bug-fix scenarios using `isolated-test` or `live-test` must
provide an explicit reset/seed recipe before they are treated as comparable;
without one, the runner records that external data was not reset and the result
should not be accepted as a confirmed before/after comparison. The example
fixture uses an explicit `POST /__fixture/reset` operation and an isolated
session header. For a real project, use a dedicated test identity and an
approved reset/seed mechanism.

## Verification checks

Project-profile commands are deterministic checks. Additional checks implement:

```ts
interface VerificationCheck {
  id: string;
  version: string;
  run(context: VerificationContext): Promise<VerificationResult>;
}
```

The result must identify the same check ID/version and return `passed`,
`failed`, or `blocked`. A check can execute an approved argument-array command
through `context.execute`; command logs become protected artifacts. Check output
is recorded separately from browser assertions. Required checks block acceptance
when they are missing, failed, or blocked.

The external example at [`../examples/custom-check.ts`](../examples/custom-check.ts)
is loaded only by an explicit `--extension PATH --trust-extension` command.
An extension may export `sourceFiles?: string[]` relative to its entry module.
The entry file and each declared local/transitive helper/configuration file are
hashed at load and rechecked during the run. Helpers and configuration files
must be declared or bundled; Secondlook does not promise to discover an import
graph automatically. Extension code is trusted host code, not a sandbox; it can
read files and use host permissions available to its Node process.

## Agent drivers

Drivers implement:

```ts
interface AgentDriver {
  id: string;
  execute(
    request: AgentExecutionRequest,
    context: {
      signal: AbortSignal;
      emit(event: ExecutionEvent): Promise<void>;
    }
  ): Promise<AgentExecutionResult>;
}
```

The result is structured (`completed` or `blocked`, summary/reason, optional
reliable usage). The coordinator decides transitions, repairs, and acceptance;
the driver cannot mark evidence as passed. The built-in `codex` driver adapts
the supported Codex TypeScript SDK. The `demo` driver is restricted to the
owned fixture and is allowed only on an explicitly marked demo run.

A custom driver can be registered in a `Registry` instance and selected by its
ID. It must preserve cancellation, avoid logging secrets, and never receive
authority to change approved scenarios or project policy. See
[agent-drivers.md](agent-drivers.md) for the real adapter boundary.

## Human approval gates

Set `policy.approvalBefore` to any of `install`, `implement`, `verify`, or
`preview`. The service persists a pending operation and blocks until the user
presses `Approve operation`. The approval key includes the review revision, so
feedback, manual edits, scenario revisions, or a new candidate cannot silently
reuse an old approval.

## Monorepo and multi-service profiles

A profile targets one application inside a repository, not the whole repository.
In a monorepo with several services and local gateway scripts, choose one
approved launch path, a loopback health URL, test auth state, a fixture mode,
and a reset recipe before creating a ticket. Secondlook cannot infer any of that
from a natural-language request, and a profile that has not been run against the
target checkout is illustrative configuration rather than a verified
integration.
