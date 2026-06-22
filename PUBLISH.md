# Publish michaelmanly/badgr-ci

This folder is a **public-only** export. Do not commit it back into the private monorepo.
Source lives in `packages/badgr-agent` inside the private gpu-ai repo.

## First-time publish

```bash
cd /path/to/badgr-ci

git init
git add .
git commit -m "Badgr Agent CI v1"

# Create public repo
gh repo create michaelmanly/badgr-ci --public --source=. --remote=origin --push

# Semver release tag + stable major ref for `uses: ...@v1`
git tag -a v1.0.0 -m "Badgr Agent CI v1.0.0"
git push origin v1.0.0
git tag -f v1 v1.0.0
git push origin v1 --force
```

## Update an existing release

```bash
./scripts/export-badgr-ci-action.sh ../badgr-ci
cd ../badgr-ci
git add .
git commit -m "Badgr Agent CI v1.0.x"
git tag v1.0.x
git push origin main --tags
git tag -f v1 v1.0.x
git push origin v1 --force
```

## GitHub Marketplace

1. Open https://github.com/marketplace/new
2. Choose **GitHub Actions** → select **michaelmanly/badgr-ci**
3. Name: **Badgr Agent CI** → Submit

## Azure Marketplace

```bash
npm install -g tfx-cli
cd /path/to/badgr-ci
tfx extension create --manifest-globs vss-extension.json
tfx extension publish --manifest-globs vss-extension.json --token <PAT>
```

## Verify (GitHub Action)

In any repo with `BADGR_API_KEY` secret:

```yaml
- uses: michaelmanly/badgr-ci@v1
  if: failure()
  with:
    badgr_api_key: ${{ secrets.BADGR_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```
