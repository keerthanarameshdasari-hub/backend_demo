# CI and security checks

This page explains what runs automatically on this repository and why. You don't need to
run any of it yourself; it all happens on GitHub when you open a pull request.

## How code moves

```
feature/* ──PR──▶ dev ──PR──▶ test ──PR──▶ main
```

Every arrow is a pull request, and every pull request into `dev`, `test` or `main` runs two
workflows:

- **CI** (`.github/workflows/ci.yml`): does the code build, pass its tests, keep its API
  contract, and produce a clean Docker image? It runs on pull requests only, and again whenever
  a label is added or removed. A new push to the same PR cancels the run it replaces.
- **Security** (`.github/workflows/security.yml`): secrets, dependencies, code scanning and
  workflow audits.

The Security workflow also runs:

- on every push to `dev` (i.e. after a PR merges), so `dev` itself is scanned and the Security
  tab reflects what is actually on the branch;
- every Monday morning, so new problems in code that hasn't changed still get noticed (a
  vulnerability can be discovered in a package years after we added it).

It never runs on `pull_request_target`, and it needs no secrets.

A pull request can only merge when all of its required checks are green. PRs into `dev` and
`test` need nothing more, so you can merge your own. PRs into `main` also need an approval from
the other maintainer (see "Who reviews what").

## CI jobs

The first five jobs run in parallel. Each one installs dependencies with `npm ci` (npm's
download cache is shared between runs) and has only read access to the code.

### Lint and types

ESLint (`npm run lint`), the TypeScript compiler with no output (`npm run typecheck`), and
Prettier (`npm run format:check`).

*Why:* catches bugs that don't need running (unused values, type errors) and keeps formatting
out of code review.

*If it fails:* run the same script locally. `npm run format` fixes formatting; ESLint and tsc
point at the line.

### Unit tests

`npm run test:unit`: the domain against in-memory fakes, plus config, adapter and architecture
tests. Fails if coverage of `src/domain` drops below 80% on statements, branches, functions or
lines.

*Why:* the business rules (KYC gate, never crediting a payment that timed out, idempotency) are
the part that must not break. Failures name the rule, e.g. "RULE BROKEN: only KYC-APPROVED
users can top up".

*If it fails:* the log names the rule and shows what happened instead. A coverage failure lists
the metric that fell short; add tests for the new domain code.

### Integration and API tests

Starts a Postgres service container (same image as `docker-compose.yml`), then:

1. `prisma migrate deploy` applies the migrations;
2. `prisma migrate reset --force` drops everything and applies every migration again from an
   empty database, proving the migrations work from zero and not only on top of an existing
   schema;
3. `npm run test:int` runs the Prisma adapters and services against that database;
4. `npm run test:api` calls every endpoint through the real app, including 401, 403 and
   validation errors.

*Why:* fakes can't catch a missing index, a migration that doesn't match `schema.prisma`, or a
wallet credited twice under concurrency.

*If it fails:* a migration failure usually means a migration was edited after it was applied,
or depends on data that isn't there on an empty database. Never edit an applied migration; add a
new one.

### API contract

1. Regenerates `openapi.json` from the code (`npm run openapi`) and fails if it differs from
   the committed file.
2. Compares `openapi.json` with the one on the target branch using
   [oasdiff](https://github.com/oasdiff/oasdiff), and fails on any **breaking** change: a
   removed endpoint or field, a new required input, a narrowed type, and so on.

*Why:* the mobile apps already in people's hands can't be updated instantly. A breaking API
change can crash them.

*If it fails:*
- "does not match the code": run `npm run openapi` and commit `openapi.json`.
- "breaking API changes": the job summary and the PR annotations list each change. Prefer an
  additive change (a new field or endpoint alongside the old one). If the break is deliberate
  and agreed, add the **`api-breaking-approved`** label to the PR; the check re-runs and passes
  with a warning. The label is read through an environment variable, never pasted into a
  script, because label names are user input.

### Docker image

Scans the `Dockerfile` with `trivy config` (fails on HIGH or CRITICAL misconfigurations), builds
the runtime image without pushing it, and scans it with `trivy image` (fails on HIGH or CRITICAL
vulnerabilities **that have a fix available**).

*Why:* the image is what actually runs. Unfixed vulnerabilities are not counted, since there's
nothing to upgrade to yet.

*If it fails:* the table names the package and the fixed version. Usually the fix is a newer
base image digest (Dependabot proposes these weekly) or a dependency upgrade.

### ci-passed

Waits for all the jobs above and fails unless **every one of them succeeded**.

*Why:* GitHub treats a required check that was *skipped* as passing. Requiring one job that
always runs (`if: always()`) and checks the others' results closes that gap, and means the
rulesets need only one CI check name, however many jobs CI has.

## Security jobs

### Secret scan (gitleaks)

Looks through **every commit in the history** for things that look like passwords, API keys
and tokens.

*Why:* once a secret is pushed to GitHub, deleting it in a later commit doesn't help. It is
still in the history and anyone who clones the repo can find it. This job catches it in
the PR, before it reaches a shared branch.

*If it fails:* the log shows the file and commit (the secret itself is redacted). Revoke the
secret with whoever issued it first, then remove it from your branch's history.

### Dependency review

Compares the dependencies in your PR with those on the branch you're merging into. It fails if
your PR **adds** a package that has a **high or critical** known vulnerability, or a package
licensed under **GPL or AGPL**.

*Why:* most of the code we ship is other people's. A vulnerable package is an easy way in for
an attacker, and GPL/AGPL licences can oblige us to publish our own source code.

*If it fails:* upgrade to a fixed version, or pick a different package. It only runs on pull
requests, so it shows as "skipped" on pushes to `dev` and the weekly run, which is expected.

### CodeQL (actions) and CodeQL (javascript-typescript)

GitHub's code analyser. It runs once per language, which is why it shows up as two checks:

- **actions** reads our workflow files and looks for things like untrusted input reaching a
  shell script, or a job with more permissions than it uses.
- **javascript-typescript** reads `src/` and looks for security bugs such as injection,
  cross-site scripting and unsafe use of user input.

*Why:* these are the bugs reviewers miss most often, because the dangerous path can run across
several files.

*If it fails:* open the **Security → Code scanning** tab for the explanation and a suggested fix.

**A later step must add more languages.** This repo has no native code yet. When `android/`
is added, add `java-kotlin` to the language list in `security.yml`; when `ios/` is added, add
`swift` (that one needs a macOS runner). Until then those folders are not analysed.

### Workflow audit (zizmor)

Checks our GitHub Actions workflow files for security mistakes: overly broad permissions,
unpinned third-party actions, untrusted input injected into shell scripts, and so on.

*Why:* CI has access to the code and often to deployment credentials. A badly written
workflow is one of the easiest ways to compromise a repository.

### Workflow lint (actionlint)

Checks workflow files for plain mistakes: YAML errors, typos in keys, wrong expression syntax,
and bugs in the shell scripts inside `run:` steps.

*Why:* without it, a typo in a workflow only shows up when the workflow runs, or quietly
makes a job do nothing.

## Rules we follow in workflows

- **Permissions start at nothing.** The workflow sets `permissions: {}` and each job asks only
  for what it needs (usually just read access to the code).
- **Third-party actions are pinned to a commit SHA**, with the version in a comment, e.g.
  `actions/checkout@3d3c42e…  # v7.0.1`. A tag like `v7` can be moved to point at different
  code; a SHA cannot.
- **Downloaded tools are checksum-verified** before they run.
- **No `pull_request_target`.** It runs PR code with write access, which is the classic way
  CI gets hijacked.
- **Never put `${{ github.event.* }}` inside a `run:` script.** Things like PR titles and branch
  names are typed by whoever opens the PR, and putting them straight into a script lets them
  run commands. Pass them through `env:` instead.
- **No secrets are needed** for these checks.

## Keeping things up to date

Dependabot (`.github/dependabot.yml`) opens a pull request into `dev` every Monday for
outdated npm packages and GitHub Actions. Minor and patch updates are grouped into one PR per
ecosystem, so there's less noise. Those PRs go through the same checks as everyone else's.

## Who reviews what

`.github/CODEOWNERS` makes @keerthanarameshdasari-hub and @Keerthana-212 the code owners of
every file, with explicit lines for CI config (`.github/`), infrastructure (`infra/`),
Dockerfiles and `package-lock.json`. Lines for `android/` and `ios/` are ready but commented
out until those folders exist.

Because every file has owners, GitHub automatically asks the other maintainer to review each
pull request; it shows up in their GitHub notifications (and email, if they have it on). What
that review means depends on where the PR is going:

- **Into `dev` or `test`** (`dev-test` ruleset): the review is optional. Once the checks are
  green you can merge your own PR.
- **Into `main`** (`main-strict` ruleset): one approval from a code owner other than the PR's
  author is required. If new commits are pushed after the approval, it is dismissed and the
  PR needs approving again. Nobody, admins included, can bypass this.

To review, open the PR, go to **Files changed → Review changes**, pick **Approve** or
**Request changes**, and submit.

## Required checks

These are the check names to require in all three branch rulesets, `dev-test` (for `dev` and
`test`) and `main-strict` (for `main`):

| Check name | Workflow | Job |
|---|---|---|
| `ci-passed` | CI | ci-passed (covers every other CI job) |
| `Secret scan (gitleaks)` | Security | gitleaks |
| `Dependency review` | Security | dependency-review |
| `CodeQL (actions)` | Security | codeql |
| `CodeQL (javascript-typescript)` | Security | codeql |
| `Workflow audit (zizmor)` | Security | zizmor |
| `Workflow lint (actionlint)` | Security | actionlint |

Don't add the individual CI jobs: `ci-passed` already requires them, and new CI jobs are covered
as soon as they're added to its `needs:` list.

If you rename a job or add a CodeQL language, update the rulesets too. A required check whose
name no longer exists never reports, and PRs wait on it forever.
