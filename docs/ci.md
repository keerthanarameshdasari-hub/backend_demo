# CI and security checks

This page explains what runs automatically on this repository and why. You don't need to
run any of it yourself; it all happens on GitHub when you open a pull request.

## How code moves

```
feature/* ──PR──▶ dev ──PR──▶ test ──PR──▶ main
```

Every arrow is a pull request, and every pull request into `dev`, `test` or `main` runs the
**Security** workflow (`.github/workflows/security.yml`). The same workflow also runs every
Monday morning, so new problems in code that hasn't changed still get noticed.

A pull request can only merge when all of its required checks are green.

## The jobs

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
requests, so it shows as "skipped" on the weekly run, which is expected.

### CodeQL (javascript-typescript)

GitHub's code analyser. It reads our JavaScript/TypeScript and looks for security bugs such as
injection, cross-site scripting and unsafe use of user input.

*Why:* these are the bugs reviewers miss most often, because the dangerous path can run across
several files.

*If it fails:* open the **Security → Code scanning** tab for the explanation and a suggested fix.
When native code is added (`android/`, `ios/`), extra languages get added to this job.

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

`.github/CODEOWNERS` makes @keerthanarameshdasari-hub the required reviewer for CI config,
infrastructure, Dockerfiles and `package-lock.json`.
