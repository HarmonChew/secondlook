# Contributing

Thanks for improving Engine. The project is intentionally small: make the
review loop more trustworthy without turning it into a universal agent
platform.

## Development setup

Requirements are Node 22.19+ (below 25), pnpm 11, Git, and Playwright Chromium. From the
repository root:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm typecheck
pnpm build
pnpm test
```

Use `pnpm dev --data-dir /tmp/engine-review-dev` for dashboard work. Use the
deterministic demo or fake driver for normal development; real provider calls are
opt-in, credentialed, and budgeted.

## Change guidelines

- Preserve the normal checkout. Runtime code belongs in owned worktrees under a
  data directory outside the checkout.
- Keep evidence grounded in actual execution. A model summary is commentary,
  never verification.
- Keep workflow decisions deterministic and separate from agent drivers.
- Add or update a schema/test when changing persisted artifacts, contexts,
  statuses, profiles, or scenario revisions.
- Keep source fingerprints and artifact references explicit. Do not hash
  arbitrary directories or accept caller-provided artifact paths.
- Do not introduce shell interpolation for model or ticket text.
- Do not add credentials, private source, auth state, screenshots, videos,
  traces, or generated runtime data to Git.
- Keep acceptance tied to the exact candidate snapshot and review revision.
- Treat executable extensions as trusted code and document their approval and
  limits.

The initial process implementation targets macOS/Linux and Windows through
WSL2. Do not claim native Windows support without testing PID identity,
process-group cleanup, ports, and signal behavior.

## Tests

Focused commands:

```bash
pnpm test                 # deterministic unit/integration coverage
pnpm test:browser         # Playwright-backed browser coverage
pnpm typecheck
pnpm build
```

Tests create temporary data directories and owned fixture repositories. They
should clean up only paths whose ownership has been verified. Never use a broad
recursive delete in a test helper.

If a test needs a browser, document whether it can run headless. If a test needs
Codex credentials, make it opt-in and do not make it part of the default CI
job.

## Pull requests

Describe the user-visible behavior, persisted-state impact, security boundary,
and tests run. For dashboard changes, include keyboard/accessibility notes and
the actual review state represented. For workflow changes, explain how stale
evidence, restart recovery, cancellation, manual edits, and acceptance behave.

Keep changes focused. Do not add publication, deployment, cloud coordination,
remote runners, a visual workflow editor, or a new model harness as an implicit
MVP dependency.

## Release readiness

The maintainer checklist for publishing this project — version control, package
metadata, CI matrix, formatting and linting, community files, the release and
upgrade policy, and disclosure hygiene — lives in
[docs/open-source-readiness.md](docs/open-source-readiness.md). Items labelled
P0 there gate any public release. Several of its small items are deliberately
good starting points for a first contribution.

By contributing, you agree that your contribution is provided under the
Apache-2.0 license in [LICENSE](LICENSE).
