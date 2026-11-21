# Repository Guidelines

## Project Structure & Module Organization

- `src/`: React + Zustand features in `canvas/`, `projects/`, `generation/`, `workflows/`, `assistant/`, `assets/`, `editors/`, and `settings/`. Reusable UI lives in `components/`; `store.ts` coordinates shared state.
- `server/`: `index.ts` starts the server; `app.ts` registers HTTP routes; `services.ts` wires dependencies. `routes/` delegates to `projects/`, `assets/`, `tasks/`, `comfy/`, `workflows/`, `agent/`, and `mcp/`.
- `shared/`: types, geometry, media helpers, licensing, and translations. Backend modules must not import `src/`.
- `test/`: automated tests; `scripts/`: development and validation utilities.
- `presets/`: generated workflow JSON; edit `scripts/preset-sources.ts` and regenerate instead of editing JSON manually.
- `docs/media/`: documentation assets. Ignored `data/` stores runtime files; `dist/` stores builds.

## Build, Test, and Development Commands

Use Node.js **22.19+** and install dependencies with `npm install`.

- `npm run dev`: start SSH tunnel handling, backend, and Vite at `http://localhost:5173`.
- `npm run dev:noTunnel`: start development servers without the tunnel.
- `npm run typecheck`: check strict TypeScript types.
- `npm test`: run all `test/*.test.ts` files.
- `npm run build`: typecheck and build the frontend.
- `npm run smoke`: verify production startup without ComfyUI; build first.
- `npm start`: serve production on `127.0.0.1:8787` by default.
- `npm run build:presets -- <id>`: regenerate a preset; requires ComfyUI and Chrome.

## Coding Style & Naming Conventions

Follow existing TypeScript/ES-module style: two-space indentation, single quotes, and semicolons. Use PascalCase for React components and types, camelCase for functions and variables. Keep shared contracts in `shared/types.ts`. No formatter or linter is configured.

Wrap Chinese interface strings in `t()` and add English entries to `shared/locales/en.ts`; use `msg()` for deferred translation. Keep model-facing assistant prompts in Chinese. See `CONTRIBUTING.md` for details.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict` through `tsx`. Name tests `*.test.ts` with behavioral descriptions. HTTP regression tests use temporary data directories. Tests need neither ComfyUI nor API keys; no coverage threshold is configured. CI runs build, tests, and smoke checks on Node 22/24/26. Validate generation changes against real ComfyUI using `npm run test:wf -- '<request JSON>'`.

## Commit & Pull Request Guidelines

Use imperative commit subjects matching history: `Add an English interface` or `Fix server crash ...`. Follow `.github/pull_request_template.md`: explain changes and reasons, link issues with `Fixes #123`, report validation and relevant ComfyUI versions/models, and attach screenshots or recordings for UI changes. Confirm MIT contribution terms.

## Security & Configuration

Keep credentials in ignored `.env`; never commit runtime data. Consult `SECURITY.md` before exposing the unauthenticated backend beyond localhost.
