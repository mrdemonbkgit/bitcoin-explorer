# Project Agents

## Product Agent
- Owns the PRD, updates requirements, and collects stakeholder feedback.
- Prioritises features aligned with the slim, LAN-only explorer vision.

## Development Agent
- Builds the Node.js/Express application and implements JSON-RPC integrations.
- Maintains coding standards, dependency hygiene, and runtime observability hooks.
- Keeps the local tooling (`npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`) green before handing work to QA.

## QA Agent
- Designs and automates regression tests for routes, caching, and error handling.
- Validates Bitcoin Core integration with mocked and live-node scenarios before release.
- Curates Vitest suites, ensures coverage thresholds remain acceptable, and updates `test/setup-env.js` defaults when RPC requirements change.

## DevOps Agent
- Defines environment configuration, deployment scripts, and runtime monitors.
- Ensures the service binds safely on the LAN and documents operational runbooks.
- Owns the GitHub Actions workflow, auditing steps (`npm run ci`, `npm audit`, `npm run build`), and keeps artifacts deployable.

## Documentation Agent
- Curates README, RUNBOOK, and architecture notes for the evolving Node.js stack.
- Keeps change logs, onboarding checklists, and CI/build guidance current for future contributors.
