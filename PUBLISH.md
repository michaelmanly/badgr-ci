# Publish michaelmanly/badgr-ci

This folder is a **public-only** export. Do not commit it back into the private monorepo.

## First-time publish

```bash
cd /path/to/badgr-ci

git init
git add .
git commit -m "Badgr Agent CI v1"

# Create public repo (requires badgr org or your user)
gh repo create michaelmanly/badgr-ci --public --source=. --remote=origin --push

git tag v1
git push origin v1
```

## Update an existing release

Bump the tag after re-exporting from gpu-ai:

```bash
./scripts/export-badgr-ci-action.sh ../badgr-ci
cd ../badgr-ci
git add .
git commit -m "Badgr Agent CI v1.0.x"
git tag v1.0.x
git push origin main --tags
```

For the stable major ref, move `v1` to the latest commit:

```bash
git tag -f v1
git push origin v1 --force
```

## GitHub Marketplace

1. Open https://github.com/marketplace/new
2. Choose **GitHub Actions**
3. Select repository **michaelmanly/badgr-ci**
4. Name: **Badgr Agent CI**
5. Submit listing

## Verify

In any repo with `BADGR_API_KEY` secret:

```yaml
- uses: michaelmanly/badgr-ci@v1
  if: failure()
  with:
    badgr_api_key: ${{ secrets.BADGR_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```
