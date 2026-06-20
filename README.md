# Badgr Agent CI

**Badgr Agent CI** diagnoses why your GitHub Actions workflows fail and posts the likely cause, evidence, and suggested fix on your pull request (or workflow summary).

Part of the **[Badgr Agent](https://aibadgr.com)** product family from [AI Badgr](https://aibadgr.com).

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Badgr_Agent_CI-blue?logo=github)](https://github.com/marketplace/actions/badgr-agent-ci)

## Install

Add one step at the end of your workflow (runs only on failure):

```yaml
permissions:
  contents: read
  actions: read
  pull-requests: write

steps:
  - uses: actions/checkout@v4
  - run: npm test

  - name: Badgr Agent CI
    uses: michaelmanly/badgr-ci@v1
    if: failure()
    with:
      badgr_api_key: ${{ secrets.BADGR_API_KEY }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
```

### 1. Get an API key

Sign up at [aibadgr.com](https://aibadgr.com) and create `BADGR_API_KEY` in **Settings → Secrets and variables → Actions**.

### 2. Permissions

The workflow job needs:

| Permission | Why |
|------------|-----|
| `contents: read` | Read repository context |
| `actions: read` | Fetch failed job logs |
| `pull-requests: write` | Post or update the diagnosis comment |

## Example comment

When CI fails, Badgr Agent CI posts:

```markdown
### Badgr Agent CI

**Likely cause:** Missing dependency `vite`

**Evidence:**
- Cannot find module 'vite'
- Failed during `npm test`

**Suggested fix:** Add to devDependencies: `npm install --save-dev vite`

**Confidence:** high
```

On reruns, the **same comment is updated** — not duplicated.

## What it does

- Fetches real logs from the failed GitHub Actions job
- Diagnoses common failures (tests, installs, TypeScript, Docker, permissions, env vars, timeouts)
- Posts one deduped PR comment (or workflow summary when no PR)
- Shows quoted evidence and a confidence score

## What it does not do

- Does not auto-fix or modify your code
- Does not rerun workflows or open/merge PRs
- Does not require changes to your existing tests

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `badgr_api_key` | Yes | Your AI Badgr API key |
| `github_token` | Yes | `${{ secrets.GITHUB_TOKEN }}` (needs PR + actions permissions) |

## Related products

| Runtime | Install |
|---------|---------|
| **Badgr Agent CI** (GitHub) | `uses: michaelmanly/badgr-ci@v1` |
| **Badgr Agent CI** (Azure) | [aibadgr.badgr-ci](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-ci) — `BadgrCI@1` |
| **Badgr Agent CLI** | `npm install -g badgr-agent` |
| **Badgr Agent Infra** | `docker run badgr/agent:infra` |
| **Badgr Auto** (VS Code) | [aibadgr.badgr-auto](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-auto) |

## Support

- Repo: [github.com/michaelmanly/badgr-ci](https://github.com/michaelmanly/badgr-ci)
- Email: [hello@aibadgr.com](mailto:hello@aibadgr.com)

## License

Apache-2.0 — see [LICENSE](LICENSE).
