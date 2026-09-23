# Agent driver boundary

Secondlook keeps model execution behind supervised adapters. The `codex` driver is
a small adapter around the supported TypeScript Codex SDK, and the `pi` driver
uses Pi AI for a selected provider/model. Both run like any other managed
process so cancellation, timeouts, logs, and descendant cleanup remain under
Secondlook’s process manager.

## Codex adapter behavior

For an implementation attempt the adapter writes a restrictive job file outside
the candidate source tree, creates a private per-attempt `CODEX_HOME`, and runs
a worker in a supervised process group. The worker starts a Codex thread with:

- the candidate worktree as `workingDirectory`;
- `workspace-write` sandbox mode;
- approval policy `never`;
- network access disabled;
- web search disabled; and
- the configured reasoning effort/model when supplied.

The adapter consumes structured SDK events and validates the final JSON result
with the runtime schema. It records only sanitized event summaries, never model
reasoning. Token usage is displayed only if the provider returns reliable usage;
otherwise the dashboard says `unavailable`.

The adapter requires `CODEX_API_KEY` in the service environment. Secondlook does
not read a user’s existing Codex conversation or credentials from an implicit
profile. Missing credentials produce a blocked attempt before a model worker is
started. The default demo and tests never make a paid call.

Example:

```bash
export CODEX_API_KEY='...'
pnpm start --data-dir /tmp/secondlook-review-real
```

The SDK’s live provider behavior is therefore an opt-in integration boundary;
the repository’s deterministic tests exercise missing-credential and malformed
result handling, not a live model run. No paid/live provider call has been
performed as part of MVP validation.

## Pi AI adapter

The `pi` driver is an Secondlook adapter around the pinned
`@earendil-works/pi-ai@0.86.1` package and requires Node `22.19+` (under the
repository’s supported `<25` range). A ticket selects it with a model object:

```json
{ "driverId": "pi", "model": { "provider": "openai", "id": "..." } }
```

In the Create a change ticket form, choosing the Pi driver reveals the Model
provider and Model selectors. They use the local static catalog and show the
provider’s API-key environment variable. Catalog configuration only checks that
the selected environment variable is present; it does not make a live provider
or permission request. Pi currently exposes these provider/key pairs:

| Provider | Environment variable |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| xAI | `XAI_API_KEY` |

This version is environment-key only. It has no OAuth flow, custom endpoint,
or local provider support. Secondlook resolves the selected catalog entry before
starting the worker, then passes only that credential reference to the
supervised process. The key value is never written to the job file or shown in
the ticket UI. A trusted bootstrap disables candidate TypeScript configuration,
so repository aliases cannot redirect provider-worker imports. Codex continues to use `CODEX_API_KEY` and its existing
`SECONDLOOK_CODEX_MODEL` configuration.

The worker is bounded to 32 model turns and 100 tool calls. Its only tools are
`list_files`, `read_file`, `write_file`, and `finish`; it has no command,
delete, or rename tools. File access is limited by the approved project
profile’s source include/exclude rules plus built-in sensitive, dependency, and
generated-path exclusions. Symlink and hard-link files are denied. Writes use
the SHA-256 returned by `read_file` as a compare-and-swap guard, so an
intervening edit is rejected. Secondlook runs approved installation and verification
commands after the worker finishes; a model’s `finish` result is not test
evidence.

Pi’s file guard is a trusted-host boundary, not an OS sandbox against a hostile
concurrent process. Hosted provider calls can receive the approved source and
request content. Pi tests use mocked streams and credential/catalog behavior;
no paid or live provider call has been performed.

## Implementing another driver

Keep the driver narrow:

1. Validate the request and required credentials before starting external work.
2. Work only in `request.workspacePath`; do not edit the normal checkout,
   approved scenario files, or policy.
3. Leave dependency installation to the approved runtime/profile commands. Do
   not add, remove, replace, or silently adopt arbitrary dependency files.
4. Emit short structured lifecycle events through `context.emit`.
5. Honor `context.signal` and return a schema-valid result.
6. Keep secrets out of prompts, logs, artifacts, and summaries.
7. Report blocked credentials, invalid output, or infrastructure errors as
   blocked/execution conditions; do not claim the application behavior passed.

The coordinator performs source fingerprinting, snapshots, browser evidence,
checks, repair limits, and state transitions. A driver must not decide that a
failed scenario is fixed from its own text response.

Executable extensions are trusted code. A maintainer may register a driver in a
host-created `Registry`, but the runtime does not silently discover or execute
new repository configuration. Explicit approval is required for extension
loading. The extension entry module may declare `sourceFiles` for local helper
and configuration dependencies; those files must be declared or bundled because
Secondlook does not guarantee automatic import-graph discovery. All declared files
are hashed and checked during the run.

## Provider documentation

The adapters follow their official TypeScript surfaces and are pinned in
`package.json`. Review the [Pi AI package documentation](https://github.com/earendil-works/pi/tree/main/packages/ai)
and the Codex SDK documentation before changing them. Model credentials,
hosted processing, retention, and network policy are provider concerns;
Secondlook’s local service cannot turn a hosted model into a local model. See
[SECURITY.md](../SECURITY.md).
