# Scenario authoring

Scenarios are the reproducible contract between the request and the review.
They should describe a user-observable path, not an implementation detail.

## Minimal shape

```json
{
  "id": "profile-persistence",
  "name": "Profile name survives refresh",
  "revision": 1,
  "route": "/profile",
  "viewport": { "width": 1280, "height": 800 },
  "fixture": {
    "mode": "isolated-test",
    "description": "Dedicated resettable test backend",
    "reset": { "path": "/__test/reset", "body": {} },
    "headersRefs": {},
    "mocks": []
  },
  "setupActions": [],
  "actions": [
    { "id": "name", "label": "Enter a name", "type": "fill", "selector": "[data-testid=display-name]", "value": "Taylor" },
    { "id": "save", "label": "Save", "type": "click", "selector": "[data-testid=save]" },
    { "id": "reload", "label": "Reload the profile", "type": "reload" },
    { "id": "persisted", "label": "Name remains after reload", "type": "assert", "selector": "[data-testid=display-name]", "condition": "value", "expected": "Taylor", "role": "expectation" }
  ],
  "regressionAssertionId": "persisted"
}
```

The complete contract is validated at run creation. Action IDs must be unique;
selectors and expected text are approved data, not model-generated executable
code. Add a precondition assertion to record starting state when that state is
important.

## Bug fixes and features

Bug-fix scenarios use the same profile, identity, viewport, fixture recipe, and
actions for baseline and candidate. Non-simulated bug-fix scenarios must include
an explicit server-side reset/seed recipe; clearing cookies is not enough. The
named regression assertion must fail on the baseline for the dashboard to say
`Regression reproduced`. If the baseline passes or cannot run, the UI says
`Original failure not reproduced` or `Environment blocked`; a passing candidate
alone is not proof of a regression fix. Manual candidate edits continue to use
the original baseline until an approved scenario revision requires a new one.

Feature scenarios are after-only. Use separate approved scenarios for populated,
empty, error, narrow viewport, or permission states when relevant. None is
mandatory by default. The dashboard labels baseline `Not applicable` rather than
inventing a before state.

## Fixture modes and reset

- `isolated-test`: use a dedicated local/test backend with an explicit reset.
- `simulated`: use approved Playwright request mocks; the UI labels this
  `Simulated API`.
- `live-test`: use a dedicated test backend and identity; do not point at
  production.

Reset is an explicit server-side operation. Clearing cookies or opening a new
tab is not enough when the backend has mutable state. Automated and interactive
contexts both apply the same reset recipe. They are separate contexts so a
human preview cannot contaminate verification. Preview is still a trusted-host
operation: it opens a managed headed browser window and does not sandbox the
candidate application from the host.

The managed browser accepts same-origin requests only. Configure a same-origin
test proxy/local gateway when an application’s backend is otherwise on another
origin.

## Capture points and evidence

Use `capture` actions when an intermediate screenshot matters. All assertions,
action results, screenshots, traces, videos, and logs are stored with the
candidate/source/context that produced them. When source, scenario revision,
profile, checks, environment, or trusted extensions change, prior evidence is
shown as stale and cannot support acceptance.

The example [`../examples/vite-scenario.json`](../examples/vite-scenario.json)
uses ordinary `data-testid` selectors. Adapt selectors and reset endpoints to the
real application; its JSON is a valid authoring example, not a universal
contract.
