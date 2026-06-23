# Badgr Pipeline Check for GitHub Actions

CI Failure Diagnosis for GitHub Actions — always-on pipeline check that diagnoses failures, checks pipeline health, and scans for security issues.

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Badgr_Pipeline_Check-blue?logo=github)](https://github.com/marketplace/actions/badgr-pipeline-check)
[![Azure Marketplace](https://img.shields.io/badge/Azure_DevOps-Badgr_Pipeline_Check-blue?logo=azure-devops)](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-ci)

---

## What Badgr checks

- **Failure diagnosis:** likely cause, evidence, suggested fix, confidence
- **Pipeline health:** slow steps, retries, bottlenecks
- **Security:** secrets, risky commands, broad permissions
- **Config audit:** missing timeouts, missing cache, unsafe defaults

## Quick start

```yaml
- name: Badgr Pipeline Check
  uses: michaelmanly/badgr-ci@v1
  if: always()
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

Rule-based checks run without any API key. Add `BADGR_API_KEY` to enable AI for ambiguous failures:

```yaml
- name: Badgr Pipeline Check
  uses: michaelmanly/badgr-ci@v1
  if: always()
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    badgr_api_key: ${{ secrets.BADGR_API_KEY }}
```

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

`GITHUB_TOKEN` is used for workflow context and optional PR comments.

```yaml
permissions:
  contents: read
  actions: read
  pull-requests: write
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
    github_token: ${{ secrets.GITHUB_TOKEN }}
    badgr_api_url: http://badgr-agent-ci.internal:8000/v1
    badgr_api_key: ${{ secrets.BADGR_INTERNAL_KEY }}
```

## Output modes

| Mode | Output |
|---|---|
| `summary` | Workflow step summary |
| `console` | Job log |
| `pr-comment` | PR comment |
| `both` | Summary plus PR comment |

Set via environment variable: `BADGR_OUTPUT_MODE: pr-comment`

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

### Does Badgr require AI?
No. Local rule-based checks run by default.

### Does Badgr send logs to AI Badgr?
Only if optional AI escalation is configured and needed. Self-hosted mode keeps logs inside your network.

### Does Badgr auto-fix code?
No. Badgr reports findings and suggested fixes.

### Can I run it without an API key?
Yes. Pipeline Check works without a Badgr API key.

## Support

- Docs: [aibadgr.com](https://aibadgr.com)
- Email: [hello@aibadgr.com](mailto:hello@aibadgr.com)

## License

Apache-2.0 — see [LICENSE](LICENSE).
