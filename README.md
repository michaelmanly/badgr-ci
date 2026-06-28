# Badgr Pipeline Check for GitHub Actions

Badgr Pipeline Check helps teams understand why GitHub Actions workflows fail.

It runs on every workflow, checks failed jobs, slow steps, risky commands, leaked secrets, and common workflow/config issues, then writes a clear report to the GitHub Step Summary, console, or pull request comment.

Local rule-based checks run by default. A Badgr API key is optional and only enables AI diagnosis for ambiguous or low-confidence failures.

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Badgr_Pipeline_Check-blue?logo=github)](https://github.com/marketplace/actions/badgr-agent-ci)
[![Azure Marketplace](https://img.shields.io/badge/Azure_DevOps-Badgr_Pipeline_Check-blue?logo=azure-devops)](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-ci)

---

## What Badgr checks

**Failure diagnosis**
Detects common workflow failures including missing dependencies, test failures, Docker build errors, TypeScript errors, package conflicts, timeouts, auth failures, and deployment issues.

**Pipeline health**
Finds slow jobs, slow install/test steps, retries, and bottlenecks.

**Security scan**
Flags secret-like values, broad token permissions, unsafe shell commands, curl | bash, --privileged flags, and sudo usage.

**Config audit**
Checks workflow YAML for missing timeouts, unpinned versions, :latest images, overbroad permissions, and hardcoded values.

## Quick start

No credentials needed — `github.token` is injected automatically:

```yaml
- name: Badgr Pipeline Check
  uses: michaelmanly/badgr-ci@v1
  if: always()
  with:
    # Optional: AI diagnosis for ambiguous failures
    # badgr_api_key: ${{ secrets.BADGR_API_KEY }}

    # Optional: open PR with AI-proposed fix instructions
    # badgr_open_pr: "true"

    # Optional: override auto-detected GitHub token for richer logs / PR comments
    # ci_token: ${{ secrets.BADGR_CI_TOKEN }}

    # Optional: output override: summary | console | pr-comment | both
    # output_mode: pr-comment

    # Optional: self-hosted/private endpoint
    # badgr_api_url: https://badgr.your-company.internal/v1
```

Default: runs local Pipeline Check with no Badgr API key. Summary output is default. Add CI token only for richer logs/comments. Add BADGR_API_KEY only for AI on ambiguous failures.

For AI fix PRs, see the **Advanced: AI fix PR** section in the [GitHub install guide](https://github.com/michaelmanly/badgr-ci/blob/main/docs/badgr-ci-github-install.md). Requires `BADGR_API_KEY` + `badgr_open_pr: "true"`. Badgr opens a PR with proposed fix instructions — not a code patch. Never auto-merges.

## How it works

1. Badgr runs on every build
2. Logs and metadata are collected
3. Secrets are redacted before analysis
4. Local rule-based checks run first
5. AI is used only for ambiguous failures, if an API key is configured
6. Results are written to summary, console, or PR comment

## When AI is used

All four checks always run as rule-based analysis, with no API calls:

| Check | How it works |
|---|---|
| **Failure** | Pattern-matched against 14+ known error types |
| **Health** | Step timing thresholds and retry detection |
| **Security** | Pattern matching for risky commands and broad permissions |
| **Audit** | YAML checks for unpinned images, missing timeouts, hardcoded values |

AI is called only when:

- the build failed
- `BADGR_API_KEY` is configured
- the rule-based failure score is low-confidence or the failure pattern is unknown

Health, security, and audit checks are always rule-based — they never call AI. If the AI call fails or is unavailable, the rule-based report is still written.

## Permissions

**No BADGR_API_KEY:**
Local checks run. No AI call.

**With BADGR_API_KEY:**
AI is used only when the workflow failed and the local failure score is low-confidence or ambiguous.

**GITHUB_TOKEN:**
Used for workflow context and optional PR comments. `pull-requests: write` is only needed if using `output_mode: pr-comment` or `both`.

**Self-hosted:**
Use BADGR_API_URL to route AI escalation to your internal Badgr container instead of aibadgr.com.

```yaml
permissions:
  contents: read   # fetch workflow YAML
  actions: read    # fetch job logs
  pull-requests: write  # only needed for PR comments
```

## Hosted and self-hosted

**Hosted mode:**
Logs are redacted locally. Badgr is only called when optional AI escalation is configured and needed.

**Self-hosted mode:**
Run the Badgr Pipeline Check container inside your network. Logs are sent only to your own container and optionally your own model endpoint.

```yaml
- name: Badgr Pipeline Check
  uses: michaelmanly/badgr-ci@v1
  if: always()
  with:
    badgr_api_url: http://badgr-agent-ci.internal:8000/v1
    badgr_api_key: ${{ secrets.BADGR_INTERNAL_KEY }}
```

## Output modes

| Mode | Output |
|---|---|
| `summary` | Workflow step summary (default) |
| `console` | Job log |
| `pr-comment` | PR comment |
| `both` | Summary plus PR comment |

Set via the `output_mode` input or `BADGR_OUTPUT_MODE` env var.

## Example output

```
### Badgr Pipeline Check

**Failure:** Missing dependency `vite`
**Evidence:** `Cannot find module 'vite'`
**Suggested fix:** `npm install --save-dev vite`
**Confidence:** high

**Health:** Test step took 8m 42s
**Security:** No secrets found
**Audit:** Consider adding a timeout
```

## Other platforms

| Platform | Install |
|---|---|
| **Azure DevOps** | `task: BadgrCI@1` — [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-ci) |
| **GitLab CI** | Download `dist/gitlab.js` from [Releases](https://github.com/michaelmanly/badgr-ci/releases/latest), then `node dist/gitlab.js` |
| **Jenkins** | Download `dist/jenkins.js` from [Releases](https://github.com/michaelmanly/badgr-ci/releases/latest), then `node dist/jenkins.js` |
| **Kubernetes** | Download `dist/k8s.js` from [Releases](https://github.com/michaelmanly/badgr-ci/releases/latest), then `node dist/k8s.js` |
| **npm** | `npm install -g badgr-agent` |
| **Docker (self-hosted)** | `docker pull michaelmanleyx/badgr-agent:infra` |

## Repository layout

```
badgr-ci/
├── action.yml          GitHub Action definition
├── dist/
│   ├── index.js        GitHub Actions bundled runner
│   ├── azure.js        Azure DevOps bundled runner
│   ├── gitlab.js       GitLab CI bundled runner
│   ├── jenkins.js      Jenkins bundled runner
│   └── k8s.js          Kubernetes bundled runner
├── BadgrCI/
│   └── task.json       Azure DevOps task manifest
├── examples/           Copy-paste workflow snippets
└── README.md
```

Source lives in the private monorepo at `packages/badgr-agent`. This public repo contains only compiled JS and docs.

## FAQ

### Does Badgr require an API key?
No. The default Pipeline Check runs local rule-based checks without a Badgr API key.

### When is AI used?
AI is only used when a build failed, a Badgr API key or private provider is configured, and the local failure score is ambiguous or low-confidence.

### Does Badgr send logs to AI Badgr every run?
No. Health, security, and audit checks are local. Known failures are handled locally. Logs are only sent for optional AI escalation when needed.

### Does Badgr auto-fix code?
No. Badgr reports findings and suggested fixes. It does not modify code, rerun pipelines, or merge PRs.

### Can I keep logs inside my network?
Yes. Use the self-hosted Badgr Pipeline Check container and set BADGR_API_URL to your internal endpoint.

## Support

- Docs: [aibadgr.com](https://aibadgr.com)
- Email: [support@aibadgr.com](mailto:support@aibadgr.com)

## License

Apache-2.0 — see [LICENSE](LICENSE).
