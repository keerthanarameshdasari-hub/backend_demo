# backend_demo

Backend for the CI/CD demo (`backend_demo`, `admin_demo`, `frontend_demo`, `infra_demo`).

Branch flow: `feature/*` → `dev` → `test` → `main`, each step by pull request.

`src/server.js` is a placeholder until the real API lands; it exists so CodeQL has
JavaScript to analyse. See [docs/ci.md](docs/ci.md) for what runs on every pull request.
