#!/usr/bin/env bash
# Run Badgr Agent CI against a Kubernetes namespace.
# Requires: kubectl configured, BADGR_API_KEY set.
#
# Usage:
#   BADGR_API_KEY=<key> ./k8s-badgr-ci.sh [--namespace=<ns>] [--selector=<label>]
#
# Download the bundled runner:
#   curl -fsSL https://github.com/michaelmanly/badgr-ci/releases/latest/download/k8s.js -o k8s.js
#
set -euo pipefail
node k8s.js "$@"
