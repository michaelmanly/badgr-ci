#!/usr/bin/env node

// packages/badgr-agent/dist/ci/github/main.js
import { readFile, appendFile } from "node:fs/promises";

// packages/shared/src/index.ts
var BadgrToolError = class extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "BadgrToolError";
  }
  code;
  details;
};
async function callBadgrApi(endpoint, body, options) {
  const fetcher = options.fetchImpl ?? fetch;
  const response = await fetcher(`${options.apiUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${options.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new BadgrToolError(`Badgr API ${endpoint} failed (HTTP ${response.status}): ${detail}`, "BADGR_API_FAILED", { status: response.status });
  }
  return response.json();
}

// packages/badgr-agent/dist/core/redaction.js
function redactSecrets(text) {
  return text.replace(/BADGR_API_KEY=[\w-]+/g, "BADGR_API_KEY=***").replace(/password[:=\s]+[\w-]+/gi, "password=***").replace(/token[:=\s]+[\w-]+/gi, "token=***").replace(/secret[:=\s]+[\w-]+/gi, "secret=***").replace(/key[:=\s]+[\w-]+/gi, "key=***");
}

// packages/badgr-agent/dist/ci/call-badgr-api.js
function validateDiagnosis(data) {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid diagnosis response: expected object");
  }
  const obj = data;
  if (typeof obj.title !== "string")
    throw new Error("Missing required field: title");
  if (typeof obj.likely_cause !== "string")
    throw new Error("Missing required field: likely_cause");
  if (!Array.isArray(obj.evidence))
    throw new Error("Missing required field: evidence");
  if (typeof obj.suggested_fix !== "string")
    throw new Error("Missing required field: suggested_fix");
  const confidence = obj.confidence;
  if (!["low", "medium", "high"].includes(confidence))
    throw new Error("Invalid confidence level");
  if (typeof obj.needs_human !== "boolean")
    throw new Error("Missing required field: needs_human");
  return {
    title: obj.title,
    likely_cause: obj.likely_cause,
    evidence: obj.evidence,
    suggested_fix: obj.suggested_fix,
    confidence: obj.confidence,
    needs_human: obj.needs_human,
    failed_job: obj.failed_job,
    failed_step: obj.failed_step,
    repeat_count: obj.repeat_count,
    comment_markdown: obj.comment_markdown
  };
}
async function callBadgrCiDiagnose(context, options) {
  const redactedSnippet = redactSecrets(context.logSnippet);
  const data = await callBadgrApi("/ci/diagnose", {
    provider: context.provider,
    repo: context.repo,
    run_id: context.runId,
    run_url: context.runUrl,
    commit_sha: context.commitSha,
    branch: context.branch,
    pr_number: context.prNumber,
    failed_job: context.failedJob,
    failed_step: context.failedStep,
    log_snippet: redactedSnippet,
    changed_files: context.changedFiles ?? []
  }, options);
  return validateDiagnosis(data);
}

// packages/badgr-agent/dist/ci/extract-logs.js
function stripAnsi(input) {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}
function extractRelevantLogSnippet(log, maxLines = 500) {
  const clean = stripAnsi(log).trim();
  const lines = clean.split(/\r?\n/);
  const failureIndex = findFailureLineIndex(lines);
  if (failureIndex === -1)
    return lines.slice(-maxLines).join("\n").slice(-12e3);
  const before = Math.floor(maxLines * 0.35);
  const start = Math.max(0, failureIndex - before);
  const end = Math.min(lines.length, start + maxLines);
  return lines.slice(start, end).join("\n").slice(-12e3);
}
function findFailureLineIndex(lines) {
  const patterns = [/error/i, /failed/i, /exception/i, /permission denied/i, /cannot find/i, /timed? out/i, /oom/i, /out of memory/i, /assert/i];
  return lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)));
}

// packages/badgr-agent/dist/ci/collect-context.js
function collectContext(input) {
  return { ...input, logSnippet: extractRelevantLogSnippet(input.log) };
}

// packages/badgr-agent/dist/ci/types.js
var BADGR_MARKER = "<!-- badgr-agent-diagnosis -->";
var BADGR_MARKER_LEGACY = "<!-- badgr-ci-diagnosis -->";

// packages/badgr-agent/dist/ci/dedupe-comment.js
function findExistingBadgrComment(comments) {
  return comments.find((comment) => {
    const text = comment.body ?? comment.content ?? "";
    return text.includes(BADGR_MARKER) || text.includes(BADGR_MARKER_LEGACY);
  });
}

// packages/badgr-agent/dist/ci/render-comment.js
function renderCiComment(diagnosis) {
  if ("comment_markdown" in diagnosis && diagnosis.comment_markdown) {
    return `${BADGR_MARKER}
${diagnosis.comment_markdown}`;
  }
  const normalized = normalizeDiagnosis(diagnosis);
  const markdown = `### Badgr Agent CI

**Likely cause:** ${normalized.likelyCause}

**Evidence:**
${normalized.evidence.map((e) => `- ${e}`).join("\n")}

**Suggested fix:** ${normalized.suggestedFix}

**Confidence:** ${normalized.confidence}${normalized.repeatCount ? `
**Repeat occurrences:** ${normalized.repeatCount}` : ""}`;
  return `${BADGR_MARKER}
${markdown}`;
}
function renderSetupErrorComment(message) {
  return `${BADGR_MARKER}
### Badgr Agent CI setup needs attention

Badgr Agent CI could not fetch the failed run logs, so it did not generate a diagnosis.

**Setup error:** ${message}
`;
}
function normalizeDiagnosis(diagnosis) {
  return {
    title: diagnosis.title,
    likelyCause: diagnosis.likelyCause ?? diagnosis.likely_cause,
    evidence: Array.isArray(diagnosis.evidence) ? diagnosis.evidence : [diagnosis.evidence ?? ""],
    suggestedFix: diagnosis.suggestedFix ?? diagnosis.suggested_fix,
    confidence: diagnosis.confidence ?? "medium",
    needsHuman: diagnosis.needsHuman ?? diagnosis.needs_human ?? false,
    failedJob: diagnosis.failedJob ?? diagnosis.failed_job,
    failedStep: diagnosis.failedStep ?? diagnosis.failed_step,
    repeatCount: diagnosis.repeatCount ?? diagnosis.repeat_count
  };
}

// packages/badgr-agent/dist/ci/github/main.js
function githubApi(path) {
  return `${process.env.GITHUB_API_URL || "https://api.github.com"}${path}`;
}
async function gh(path, token, init = {}) {
  const response = await fetch(githubApi(path), {
    method: init.method ?? "GET",
    headers: {
      "authorization": `Bearer ${token}`,
      "accept": "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: init.body
  });
  if (!response.ok)
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${await response.text()}`);
  return await response.json();
}
async function getPullRequestNumber() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request" && process.env.GITHUB_EVENT_NAME !== "pull_request_target")
    return void 0;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath)
    return void 0;
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  return event.pull_request?.number ?? event.number;
}
async function fetchFailedLogs(token, repo, runId) {
  const jobs = await gh(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  const failedJob = jobs.jobs?.find((job) => ["failure", "timed_out", "cancelled"].includes(job.conclusion || ""));
  if (!failedJob)
    return { logSnippet: "", setupError: "No failed GitHub Actions job was found for this run." };
  const failedStep = failedJob.steps?.find((step) => ["failure", "timed_out", "cancelled"].includes(step.conclusion || ""));
  const logsUrl = failedJob.logs_url || (failedJob.id ? githubApi(`/repos/${repo}/actions/jobs/${failedJob.id}/logs`) : void 0);
  if (!logsUrl)
    return { failedJob: failedJob.name, failedStep: failedStep?.name, logSnippet: "", setupError: "The GitHub job logs URL was unavailable. Ensure actions: read permission is granted." };
  const logResponse = await fetch(logsUrl, { headers: { "authorization": `Bearer ${token}`, "accept": "text/plain" } });
  if (!logResponse.ok)
    return { failedJob: failedJob.name, failedStep: failedStep?.name, logSnippet: "", setupError: `Could not fetch GitHub job logs (HTTP ${logResponse.status}). Ensure actions: read permission is granted.` };
  return { failedJob: failedJob.name, failedStep: failedStep?.name, logSnippet: await logResponse.text() };
}
async function publishToSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath)
    await appendFile(summaryPath, `
${markdown}
`, "utf8");
  else
    console.log(markdown);
}
async function upsertPrComment(token, repo, prNumber, markdown) {
  const comments = await gh(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`, token);
  const existing = findExistingBadgrComment(comments);
  if (existing) {
    await gh(`/repos/${repo}/issues/comments/${existing.id}`, token, { method: "PATCH", body: JSON.stringify({ body: markdown }) });
  } else {
    await gh(`/repos/${repo}/issues/${prNumber}/comments`, token, { method: "POST", body: JSON.stringify({ body: markdown }) });
  }
}
async function run() {
  const apiKey = process.env.BADGR_API_KEY || process.env.INPUT_BADGR_API_KEY;
  const token = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!apiKey)
    throw new Error("BADGR_API_KEY or badgr_api_key input is required");
  if (!token)
    throw new Error("GITHUB_TOKEN or github_token input is required. Grant contents: read, actions: read, pull-requests: write, checks: write.");
  if (!repo || !runId)
    throw new Error("GITHUB_REPOSITORY and GITHUB_RUN_ID are required in GitHub Actions.");
  const prNumber = await getPullRequestNumber();
  const logs = await fetchFailedLogs(token, repo, runId);
  if (logs.setupError || !logs.logSnippet) {
    const setupComment = renderSetupErrorComment(logs.setupError || "No failed logs were available.");
    if (prNumber)
      await upsertPrComment(token, repo, prNumber, setupComment);
    await publishToSummary(setupComment);
    return;
  }
  const context = collectContext({
    provider: "github",
    repo,
    runId,
    runUrl: process.env.GITHUB_SERVER_URL ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}` : void 0,
    commitSha: process.env.GITHUB_SHA,
    branch: process.env.GITHUB_REF_NAME,
    prNumber,
    failedJob: logs.failedJob,
    failedStep: logs.failedStep,
    log: logs.logSnippet
  });
  const diagnosis = await callBadgrCiDiagnose(context, { apiUrl: process.env.BADGR_API_URL || "https://aibadgr.com/v1", apiKey });
  const comment = renderCiComment(diagnosis);
  if (prNumber)
    await upsertPrComment(token, repo, prNumber, comment);
  else
    await publishToSummary(comment);
}
if (process.env.BADGR_CI_NO_AUTO_RUN !== "1")
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
export {
  run
};
