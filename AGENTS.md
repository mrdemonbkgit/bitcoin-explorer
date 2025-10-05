# Project Agents

## Product Agent
- Owns the PRD, updates requirements, and collects stakeholder feedback.
- Prioritises features aligned with the slim, LAN-only explorer vision.
- Requires a '## Task Tracker' checklist in associated design/implementation docs for new features, scoped to deliverables and non-goals.
- Logs major decisions and scope updates in `WORKLOG.md` with links to PRD/design docs.

## Development Agent
- Builds the Node.js/Express application and implements JSON-RPC integrations.
- Maintains coding standards, dependency hygiene, and runtime observability hooks.
- Keeps the local tooling (`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`) green before handing work to QA.
- When authoring design/implementation docs, include a '## Task Tracker' checklist with actionable items; update checkboxes in PRs and link tasks to issues/PRs.
- Adds a 'Done' entry to `WORKLOG.md` on merge with PR/issue links and any follow-ups.

## QA Agent
- Designs and automates regression tests for routes, caching, and error handling.
- Validates Bitcoin Core integration with mocked and live-node scenarios before release.
- Curates Vitest suites, ensures coverage thresholds remain acceptable, and updates `test/setup-env.js` defaults when RPC requirements change.
- Ensures Task Tracker sections include test coverage items (unit, integration, regtest) and uses CI gates to enforce green checks.
- Updates `WORKLOG.md` with notable test coverage changes, regressions found/fixed, and regtest results.

## DevOps Agent
- Defines environment configuration, deployment scripts, and runtime monitors.
- Ensures the service binds safely on the LAN and documents operational runbooks.
- Owns the GitHub Actions workflow, auditing steps (`npm run ci`, `npm audit`, `npm run build`), and keeps artifacts deployable.
- Manages CI secrets, including provisioning `GITHUB_TOKEN` for automation scripts and release tooling, and documents usage expectations.
- Documents how local tooling and Codex automation should read `GITHUB_TOKEN` from `.env` and verifies no secrets leak outside the intended environment.
- Provides Codex with scoped access to `GITHUB_TOKEN` via `.env` for required GitHub operations.
- Ensures `GITHUB_TOKEN`-backed GitHub operations (e.g., fetch, push, release automation) are scoped correctly.
- Ensures Task Tracker includes CI/CD, secrets, environment variables, and operational runbook tasks for any new work.
- Logs CI/CD workflow changes, deployments, and operational notes in `WORKLOG.md`.

## GitHub Operations
- Export the `.env` variables in the active shell before running authenticated git commands: `set -a; source .env; set +a`.
- Use the `.env`-provided `GITHUB_TOKEN` via an inline credential helper for pushes, fetches, and other authenticated operations.

```bash
set -a; source .env; set +a; git -c credential.helper="!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f" push origin main
```

- Reuse the same `credential.helper` snippet for other GitHub actions (e.g., `fetch`, `pull`, `push`, `clone`) while the token is exported.
- Keep the token confined to the shell session; do not commit or log it.

## Documentation Agent
- Curates README, RUNBOOK, and architecture notes for the evolving Node.js stack.
- Keeps change logs, onboarding checklists, and CI/build guidance current for future contributors.
- Enforces the Task Tracker convention in design/implementation docs; provides templates and keeps checklists in sync with merged work.
- Maintains `WORKLOG.md` structure and quality; ensures entries are concise, linked, and reverse-chronological.

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

- Added a Task Tracker convention section and role-specific responsibilities to include and maintain checklists in design/implementation docs.

## Commit Convention: Conventional Commits
- Use Conventional Commits for all commit messages and PR titles.
- Format: `type(scope): summary`
  - `type`: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
  - `scope` (optional): api, rpc, cache, server, views, mempool, zmq, logger, docs, ci
  - `summary`: imperative, <= 72 characters
- Body (optional but encouraged): explain what/why, link context.
- Footer (optional):
  - `BREAKING CHANGE: <description>`
  - `Refs #<issue>` / `Closes #<issue>`

### Role Expectations
- Product Agent: ensure PR titles follow the convention; tie to PRD/tasks.
- Development Agent: write Conventional Commits; include tests context in body; reference issues.
- QA Agent: use `test:` for test-only changes; link to coverage goals/issues.
- DevOps Agent: use `ci:`/`build:` for workflow and packaging changes.
- Documentation Agent: use `docs:` for README/RUNBOOK/design changes.

### Examples
```text
feat(api): add /api/v1/tip endpoint

Expose chain tip summary as JSON. Reuse tip service; add envelope.

Refs #145
```
```text
fix(rpc): map ECONNABORTED to 503 ServiceUnavailableError

Avoid generic error; improves operator clarity when Core is unreachable.

Closes #152
```
```text
ci: add Node 20 build and test workflow

Runs install, build, and unit tests on push and PR.
```

## Work Log Convention: WORKLOG.md
- File: `WORKLOG.md` at the repository root.
- Purpose: daily reverse-chronological summary of progress, decisions, and next steps.
- Cadence: add/update an entry when opening/merging PRs or making notable decisions.
- Content: "Done", "In Progress", "Next", "Blockers/Risks", and links to PRs/issues and relevant design docs.
- Ownership: all agents contribute; Documentation Agent curates format and consistency.
- PR hygiene: reference the updated work log entry in PR descriptions when applicable.
- Before adding an entry, confirm the heading date is correct (use `date +%Y-%m-%d` local time) so the log remains strictly reverse-chronological.
