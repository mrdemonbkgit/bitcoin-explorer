# Project Agents

## Product Agent
- Owns the PRD, updates requirements, and collects stakeholder feedback.
- Prioritises features aligned with the slim, LAN-only explorer vision.
- Requires a '## Task Tracker' checklist in associated design/implementation docs for new features, scoped to deliverables and non-goals.

## Development Agent
- Builds the Node.js/Express application and implements JSON-RPC integrations.
- Maintains coding standards, dependency hygiene, and runtime observability hooks.
- Keeps the local tooling (`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`) green before handing work to QA.
- When authoring design/implementation docs, include a '## Task Tracker' checklist with actionable items; update checkboxes in PRs and link tasks to issues/PRs.

## QA Agent
- Designs and automates regression tests for routes, caching, and error handling.
- Validates Bitcoin Core integration with mocked and live-node scenarios before release.
- Curates Vitest suites, ensures coverage thresholds remain acceptable, and updates `test/setup-env.js` defaults when RPC requirements change.
- Ensures Task Tracker sections include test coverage items (unit, integration, regtest) and uses CI gates to enforce green checks.

## DevOps Agent
- Defines environment configuration, deployment scripts, and runtime monitors.
- Ensures the service binds safely on the LAN and documents operational runbooks.
- Owns the GitHub Actions workflow, auditing steps (`npm run ci`, `npm audit`, `npm run build`), and keeps artifacts deployable.
- Ensures Task Tracker includes CI/CD, secrets, environment variables, and operational runbook tasks for any new work.

## Documentation Agent
- Curates README, RUNBOOK, and architecture notes for the evolving Node.js stack.
- Keeps change logs, onboarding checklists, and CI/build guidance current for future contributors.
- Enforces the Task Tracker convention in design/implementation docs; provides templates and keeps checklists in sync with merged work.

## Documentation Convention: Task Tracker in Design/Implementation Docs
- All design/implementation docs (e.g., `docs/design/*.md`) must include a '## Task Tracker' section near the top.
- Use GitHub Markdown checkboxes and group tasks by phase or area; add owners in parentheses (e.g., Dev, QA, DevOps, Docs).
- Update checkboxes during PRs; "done" means merged to `main`. Prefer linking tasks to issues/PRs.
- Example skeleton:
```md
## Task Tracker
- [ ] Phase/Area — (Owner)
  - [ ] Task 1
  - [ ] Task 2
- [ ] Phase/Area — (Owner)
  - [ ] Task A
  - [ ] Task B
```
```

- Added a Task Tracker convention section and role-specific responsibilities to include and maintain checklists in design/implementation docs.