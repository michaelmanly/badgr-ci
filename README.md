# Badgr Agent CI

**Badgr Agent CI** diagnoses why your CI pipeline fails and posts the likely cause, evidence, and suggested fix — on the PR, MR, build thread, or pipeline console.

Part of the **[Badgr Agent](https://aibadgr.com)** product family from [AI Badgr](https://aibadgr.com).

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Badgr_Agent_CI-blue?logo=github)](https://github.com/marketplace/actions/badgr-agent-ci)
[![Azure Marketplace](https://img.shields.io/badge/Azure_DevOps-aibadgr.badgr--ci-blue?logo=azure-devops)](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-ci)

---

## Quick start

### GitHub Actions

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

### Azure DevOps

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-ci) and add to your pipeline:

```yaml
- task: BadgrCI@1
  condition: failed()
  env:
    BADGR_API_KEY: $(BADGR_API_KEY)
    SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

### GitLab CI

```yaml
badgr-ci:
  stage: diagnose
  image: node:20
  when: on_failure
  script:
    - node dist/gitlab.js
  variables:
    BADGR_API_KEY: $BADGR_API_KEY
    GITLAB_TOKEN: $GITLAB_TOKEN
```

Download the bundled runner: `dist/gitlab.js` from [Releases](https://github.com/michaelmanly/badgr-ci/releases/latest).

### Jenkins

```groovy
post {
  failure {
    sh 'node badgr-jenkins.js'
  }
}
```

Download the bundled runner: `dist/jenkins.js` from [Releases](https://github.com/michaelmanly/badgr-ci/releases/latest).  
Set credentials: `BADGR_API_KEY` (Jenkins credential binding).

### Kubernetes

```bash
BADGR_API_KEY=<key> node dist/k8s.js --namespace=my-ns
```

Download the bundled runner: `dist/k8s.js` from [Releases](https://github.com/michaelmanly/badgr-ci/releases/latest).  
Requires `kubectl` configured and pointing at the target cluster.

---

## Get an API key

Sign up at [aibadgr.com](https://aibadgr.com) and create `BADGR_API_KEY` in your CI secrets.

## What it does

- Fetches real logs from the failed job/task/pipeline/pod
- Diagnoses common failures (tests, installs, TypeScript, Docker, permissions, env vars, timeouts, OOM, CrashLoopBackOff)
- Posts one deduped comment/thread (or pipeline console output when no PR/MR)
- Shows quoted evidence and a confidence score

## Example comment

```markdown
### Badgr Agent CI

**Likely cause:** Missing dependency `vite`

**Evidence:**
- Cannot find module 'vite'
- Failed during `npm test`

**Suggested fix:** Add to devDependencies: `npm install --save-dev vite`

**Confidence:** high
```

## Adapters

| Runtime | Install | Entry |
|---------|---------|-------|
| **GitHub Actions** | `uses: michaelmanly/badgr-ci@v1` | `dist/index.js` |
| **Azure DevOps** | `task: BadgrCI@1` (Marketplace) | `dist/azure.js` |
| **GitLab CI** | Download `dist/gitlab.js` | `dist/gitlab.js` |
| **Jenkins** | Download `dist/jenkins.js` | `dist/jenkins.js` |
| **Kubernetes** | Download `dist/k8s.js` | `dist/k8s.js` |

## Repository layout

```
badgr-ci/
├── action.yml          GitHub Action definition
├── dist/
│   ├── index.js        GitHub Action bundled runner
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

## Related products

| Product | Install |
|---------|---------|
| **Badgr Agent CLI** | `npm install -g badgr-agent` |
| **Badgr Auto** (VS Code) | [aibadgr.badgr-auto](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-auto) |

## Support

- Docs: [aibadgr.com/docs](https://aibadgr.com/docs)
- Email: [hello@aibadgr.com](mailto:hello@aibadgr.com)

## License

Apache-2.0 — see [LICENSE](LICENSE).
