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
var RULES = [
  // Explicit BADGR key first
  [/BADGR_API_KEY[:=\s"'`]+\S+/g, "BADGR_API_KEY=***"],
  // Common named secret vars in env/config/log output
  [/\b(password|passwd|pwd|secret|token|apikey|api_key|credential|auth_token|access_token|refresh_token|private_key)[:=\s"'`]+\S+/gi, "$1=***"],
  // Bearer / Basic auth headers
  [/Bearer [A-Za-z0-9._\-+/]{10,}/g, "Bearer ***"],
  [/Basic [A-Za-z0-9+/=]{10,}/g, "Basic ***"],
  // JWTs — three dot-separated base64url segments starting with eyJ
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[JWT ***]"],
  // AWS IAM access key ID
  [/AKIA[A-Z0-9]{16}/g, "[AWS_KEY ***]"],
  // GitHub token formats (PATs, server, runner, OAuth)
  [/\b(github_pat_|ghp_|ghs_|ghr_|gho_)[A-Za-z0-9_]{30,}/g, "[GH_TOKEN ***]"],
  // GitLab PATs
  [/\bglpat-[A-Za-z0-9_\-]{20,}/g, "[GL_TOKEN ***]"],
  // Azure storage account key
  [/AccountKey=[A-Za-z0-9+/=]{20,}/g, "AccountKey=***"],
  // Azure SAS tokens
  [/SharedAccessSignature [^\n"']{10,}/g, "SharedAccessSignature ***"],
  // Database / service connection strings with embedded credentials
  [/(mongodb(\+srv)?|postgres(ql)?|mysql|redis|amqps?):\/\/[^@\s]{3,}@/gi, "$1://***@"]
];
function redactSecretsWithCount(text) {
  let result = text;
  let count = 0;
  for (const [pattern, replacement] of RULES) {
    const matches = result.match(pattern);
    count += matches?.length ?? 0;
    result = result.replace(pattern, replacement);
  }
  return { redacted: result, count };
}

// packages/badgr-agent/dist/ci/call-badgr-api.js
var DEFAULT_API_URL = "https://aibadgr.com/v1";
async function withRetry(fn, retries = 2, delayMs = 2e3) {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTransient = /HTTP (429|502|503|504)/.test(msg) || /network|econnrefused|etimedout/i.test(msg);
    if (retries <= 0 || !isTransient)
      throw err;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return withRetry(fn, retries - 1, delayMs * 2);
  }
}
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
  const owner = obj.owner;
  const validOwners = ["app", "devops", "cloud", "security"];
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
    comment_markdown: obj.comment_markdown,
    owner: validOwners.includes(owner ?? "") ? owner : void 0
  };
}
async function callBadgrCiDiagnose(context, options) {
  const { redacted: redactedSnippet, count: redactionCount } = redactSecretsWithCount(context.logSnippet);
  if (redactionCount > 0) {
    console.log(`Badgr redacted ${redactionCount} possible secret${redactionCount === 1 ? "" : "s"} before analysis.`);
  }
  const payload = {
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
  };
  if (process.env.BADGR_DRY_RUN === "1") {
    console.log("[Badgr dry-run] Would POST to /ci/diagnose with payload:");
    console.log(JSON.stringify(payload, null, 2));
    return {
      title: "[dry-run] Diagnosis skipped",
      likely_cause: "BADGR_DRY_RUN=1 \u2014 no API call made",
      evidence: [],
      suggested_fix: "Remove BADGR_DRY_RUN to enable live diagnosis",
      confidence: "low",
      needs_human: false,
      redactionCount
    };
  }
  const data = await withRetry(() => callBadgrApi("/ci/diagnose", payload, options));
  return { ...validateDiagnosis(data), redactionCount };
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

// packages/badgr-agent/dist/ci/output-mode.js
function getOutputMode() {
  const raw = (process.env.BADGR_OUTPUT_MODE ?? "summary").toLowerCase().trim();
  if (raw === "summary" || raw === "pr-comment" || raw === "console" || raw === "both")
    return raw;
  console.warn(`[Badgr] Unknown BADGR_OUTPUT_MODE value "${process.env.BADGR_OUTPUT_MODE}" \u2014 defaulting to "summary". Valid values: summary, pr-comment, console, both`);
  return "summary";
}
function shouldPostPrComment(mode) {
  return mode === "pr-comment" || mode === "both";
}
function shouldPostSummary(mode) {
  return mode === "summary" || mode === "both";
}

// packages/badgr-agent/dist/ci/mode.js
function getBadgrMode() {
  const raw = (process.env.BADGR_MODE ?? "failure").toLowerCase().trim();
  if (raw === "failure" || raw === "health" || raw === "audit" || raw === "security")
    return raw;
  console.warn(`[Badgr] Unknown BADGR_MODE value "${process.env.BADGR_MODE}" \u2014 defaulting to "failure". Valid values: failure, health, audit, security`);
  return "failure";
}

// packages/badgr-agent/dist/ci/call-badgr-mode.js
async function withRetry2(fn, retries = 2, delayMs = 2e3) {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTransient = /HTTP (429|502|503|504)/.test(msg) || /network|econnrefused|etimedout/i.test(msg);
    if (retries <= 0 || !isTransient)
      throw err;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return withRetry2(fn, retries - 1, delayMs * 2);
  }
}
var YAML_MAX_BYTES = 32 * 1024;
async function callBadgrCiHealth(context, options) {
  const { redacted: redactedSnippet, count: redactionCount } = redactSecretsWithCount(context.logSnippet);
  if (redactionCount > 0) {
    console.log(`Badgr redacted ${redactionCount} possible secret${redactionCount === 1 ? "" : "s"} before analysis.`);
  }
  const payload = {
    provider: context.provider,
    repo: context.repo,
    run_id: context.runId,
    run_url: context.runUrl,
    commit_sha: context.commitSha,
    branch: context.branch,
    log_snippet: redactedSnippet
  };
  if (process.env.BADGR_DRY_RUN === "1") {
    console.log("[Badgr dry-run] Would POST to /ci/health with payload:");
    console.log(JSON.stringify(payload, null, 2));
    return { summary: "[dry-run] Health check skipped", slowest_steps: [], cache_misses: [], retry_count: 0, flaky_tests: [], suggestions: [], redactionCount };
  }
  const data = await withRetry2(() => callBadgrApi("/ci/health", payload, options));
  return { ...validateHealthReport(data), redactionCount };
}
async function callBadgrCiAudit(context, workflowYaml, options) {
  const { redacted: redactedSnippet } = redactSecretsWithCount(context.logSnippet);
  const cappedYaml = workflowYaml && workflowYaml.length > YAML_MAX_BYTES ? workflowYaml.slice(0, YAML_MAX_BYTES) + "\n# [Badgr: YAML truncated at 32KB]" : workflowYaml;
  const payload = {
    provider: context.provider,
    repo: context.repo,
    run_id: context.runId,
    run_url: context.runUrl,
    branch: context.branch,
    log_snippet: redactedSnippet,
    workflow_yaml: cappedYaml
  };
  if (process.env.BADGR_DRY_RUN === "1") {
    console.log("[Badgr dry-run] Would POST to /ci/audit with payload:");
    console.log(JSON.stringify(payload, null, 2));
    return { summary: "[dry-run] Audit skipped", findings: [], total_findings: 0, high_count: 0, medium_count: 0, low_count: 0 };
  }
  const data = await withRetry2(() => callBadgrApi("/ci/audit", payload, options));
  return validateAuditReport(data);
}
async function callBadgrCiSecurity(context, options) {
  const { redacted: redactedSnippet, count: redactionCount } = redactSecretsWithCount(context.logSnippet);
  if (redactionCount > 0) {
    console.log(`Badgr redacted ${redactionCount} possible secret${redactionCount === 1 ? "" : "s"} before security scan.`);
  }
  const payload = {
    provider: context.provider,
    repo: context.repo,
    run_id: context.runId,
    run_url: context.runUrl,
    branch: context.branch,
    log_snippet: redactedSnippet,
    redaction_count: redactionCount
  };
  if (process.env.BADGR_DRY_RUN === "1") {
    console.log("[Badgr dry-run] Would POST to /ci/security with payload:");
    console.log(JSON.stringify(payload, null, 2));
    return { summary: "[dry-run] Security scan skipped", findings: [], redaction_count: redactionCount, total_findings: 0 };
  }
  const data = await withRetry2(() => callBadgrApi("/ci/security", payload, options));
  return validateSecurityReport(data);
}
function validateHealthReport(data) {
  const obj = data;
  return {
    summary: String(obj.summary ?? ""),
    pipeline_duration_seconds: typeof obj.pipeline_duration_seconds === "number" ? obj.pipeline_duration_seconds : void 0,
    slowest_steps: Array.isArray(obj.slowest_steps) ? obj.slowest_steps : [],
    duration_regression: typeof obj.duration_regression === "string" ? obj.duration_regression : void 0,
    cache_misses: Array.isArray(obj.cache_misses) ? obj.cache_misses : [],
    retry_count: typeof obj.retry_count === "number" ? obj.retry_count : 0,
    flaky_tests: Array.isArray(obj.flaky_tests) ? obj.flaky_tests : [],
    queue_time_seconds: typeof obj.queue_time_seconds === "number" ? obj.queue_time_seconds : void 0,
    wasted_time_seconds: typeof obj.wasted_time_seconds === "number" ? obj.wasted_time_seconds : void 0,
    suggestions: Array.isArray(obj.suggestions) ? obj.suggestions : []
  };
}
function validateAuditReport(data) {
  const obj = data;
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  return {
    summary: String(obj.summary ?? ""),
    findings,
    total_findings: findings.length,
    high_count: findings.filter((f) => f.severity === "high").length,
    medium_count: findings.filter((f) => f.severity === "medium").length,
    low_count: findings.filter((f) => f.severity === "low").length
  };
}
function validateSecurityReport(data) {
  const obj = data;
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  return {
    summary: String(obj.summary ?? ""),
    findings,
    redaction_count: typeof obj.redaction_count === "number" ? obj.redaction_count : 0,
    total_findings: findings.length
  };
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
    const redactionNote2 = diagnosis.redactionCount ? `
> _Badgr redacted ${diagnosis.redactionCount} possible secret${diagnosis.redactionCount === 1 ? "" : "s"} before analysis._
` : "";
    return `${BADGR_MARKER}
${redactionNote2}${diagnosis.comment_markdown}`;
  }
  const normalized = normalizeDiagnosis(diagnosis);
  const redactionNote = diagnosis.redactionCount ? `
> _Badgr redacted ${diagnosis.redactionCount} possible secret${diagnosis.redactionCount === 1 ? "" : "s"} before analysis._
` : "";
  const markdown = `### Badgr Agent CI
${redactionNote}
**Likely cause:** ${normalized.likelyCause}

**Evidence:**
${normalized.evidence.map((e) => `- ${e}`).join("\n")}

**Suggested fix:** ${normalized.suggestedFix}

**Confidence:** ${normalized.confidence}${normalized.repeatCount ? `
**Repeat occurrences:** ${normalized.repeatCount}` : ""}${normalized.owner ? `
**Owner:** ${normalized.owner}` : ""}`;
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
    repeatCount: diagnosis.repeatCount ?? diagnosis.repeat_count,
    owner: diagnosis.owner
  };
}

// packages/badgr-agent/dist/ci/render-report.js
var SEVERITY_ICON = {
  critical: "\u{1F534}",
  high: "\u{1F7E0}",
  medium: "\u{1F7E1}",
  low: "\u26AA"
};
function renderHealthReport(report) {
  const lines = [`${BADGR_MARKER}`, `### Badgr Agent CI \u2014 Pipeline Health`];
  if (report.redactionCount) {
    lines.push(`
> _Badgr redacted ${report.redactionCount} possible secret${report.redactionCount === 1 ? "" : "s"} before analysis._
`);
  }
  lines.push(`
${report.summary}`);
  if (report.pipeline_duration_seconds !== void 0) {
    lines.push(`
**Total duration:** ${formatDuration(report.pipeline_duration_seconds)}`);
  }
  if (report.duration_regression) {
    lines.push(`**Duration regression:** ${report.duration_regression}`);
  }
  if (report.queue_time_seconds !== void 0) {
    lines.push(`**Queue time:** ${formatDuration(report.queue_time_seconds)}`);
  }
  if (report.wasted_time_seconds !== void 0) {
    lines.push(`**Wasted time:** ${formatDuration(report.wasted_time_seconds)}`);
  }
  if (report.slowest_steps.length > 0) {
    lines.push(`
**Slowest steps:**`);
    for (const step of report.slowest_steps.slice(0, 5)) {
      lines.push(`- ${step.name}: ${formatDuration(step.duration_seconds)}`);
    }
  }
  if (report.cache_misses.length > 0) {
    lines.push(`
**Cache misses:** ${report.cache_misses.join(", ")}`);
  }
  if (report.retry_count > 0) {
    lines.push(`**Retries:** ${report.retry_count}`);
  }
  if (report.flaky_tests.length > 0) {
    lines.push(`
**Flaky tests detected:**`);
    for (const test of report.flaky_tests.slice(0, 5)) {
      lines.push(`- ${test}`);
    }
  }
  if (report.suggestions.length > 0) {
    lines.push(`
**Suggestions:**`);
    for (const s of report.suggestions) {
      lines.push(`- ${s}`);
    }
  }
  return lines.join("\n");
}
function renderAuditReport(report) {
  const lines = [
    `${BADGR_MARKER}`,
    `### Badgr Agent CI \u2014 Pipeline Audit`,
    ``,
    report.summary,
    ``,
    `**Findings:** ${report.total_findings} (${report.high_count} high, ${report.medium_count} medium, ${report.low_count} low)`
  ];
  if (report.findings.length > 0) {
    lines.push(``);
    for (const finding of report.findings) {
      const icon = SEVERITY_ICON[finding.severity] ?? "\u26AA";
      const fileNote = finding.file ? ` in \`${finding.file}\`` : "";
      lines.push(`**${icon} [${finding.severity.toUpperCase()}]** ${finding.description}${fileNote}`);
      lines.push(`  \u2192 ${finding.suggestion}`);
      lines.push(``);
    }
  }
  return lines.join("\n");
}
function renderSecurityReport(report) {
  const lines = [
    `${BADGR_MARKER}`,
    `### Badgr Agent CI \u2014 Security Scan`
  ];
  if (report.redaction_count > 0) {
    lines.push(`
> _Badgr redacted ${report.redaction_count} possible secret${report.redaction_count === 1 ? "" : "s"} before scanning._
`);
  }
  lines.push(``, report.summary, ``);
  lines.push(`**Findings:** ${report.total_findings}`);
  if (report.findings.length > 0) {
    lines.push(``);
    for (const finding of report.findings) {
      const icon = SEVERITY_ICON[finding.severity] ?? "\u26AA";
      lines.push(`**${icon} [${finding.severity.toUpperCase()}]** ${finding.description}`);
      lines.push(`  \u2192 ${finding.recommendation}`);
      lines.push(``);
    }
  }
  return lines.join("\n");
}
function formatDuration(seconds) {
  if (seconds < 60)
    return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
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
async function fetchAllJobsLog(token, repo, runId) {
  const jobs = await gh(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  if (!jobs.jobs?.length)
    return "";
  const parts = [];
  for (const job of jobs.jobs) {
    const started = job.started_at ? new Date(job.started_at) : null;
    const completed = job.completed_at ? new Date(job.completed_at) : null;
    const durationSec = started && completed ? Math.round((completed.getTime() - started.getTime()) / 1e3) : null;
    parts.push(`=== Job: ${job.name} (${job.conclusion ?? "running"}) ${durationSec !== null ? `${durationSec}s` : ""} ===`);
    if (job.steps?.length) {
      for (const step of job.steps) {
        const ss = step.started_at ? new Date(step.started_at) : null;
        const sc = step.completed_at ? new Date(step.completed_at) : null;
        const sd = ss && sc ? Math.round((sc.getTime() - ss.getTime()) / 1e3) : null;
        parts.push(`  Step: ${step.name} (${step.conclusion ?? "running"}) ${sd !== null ? `${sd}s` : ""}`);
      }
    }
  }
  return parts.join("\n");
}
async function fetchWorkflowYaml(token, repo) {
  const workflowPath = process.env.GITHUB_WORKFLOW_REF;
  if (!workflowPath)
    return void 0;
  const match = workflowPath.match(/\.github\/workflows\/[^@]+/);
  if (!match)
    return void 0;
  const filePath = match[0];
  try {
    const ref = process.env.GITHUB_SHA ?? process.env.GITHUB_REF_NAME ?? "HEAD";
    const resp = await gh(`/repos/${repo}/contents/${filePath}?ref=${ref}`, token);
    if (resp.content && resp.encoding === "base64") {
      return Buffer.from(resp.content.replace(/\n/g, ""), "base64").toString("utf8");
    }
  } catch {
  }
  return void 0;
}
async function run() {
  const apiKey = process.env.BADGR_API_KEY || process.env.INPUT_BADGR_API_KEY;
  const token = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const outputMode = getOutputMode();
  const badgrMode = getBadgrMode();
  if (!apiKey)
    throw new Error("BADGR_API_KEY or badgr_api_key input is required");
  if (!token)
    throw new Error("GITHUB_TOKEN or github_token input is required. Grant contents: read, actions: read" + (shouldPostPrComment(outputMode) ? ", pull-requests: write" : "") + ".");
  if (!repo || !runId)
    throw new Error("GITHUB_REPOSITORY and GITHUB_RUN_ID are required in GitHub Actions.");
  const apiOptions = {
    apiUrl: process.env.BADGR_API_URL || process.env.INPUT_BADGR_API_URL || DEFAULT_API_URL,
    apiKey
  };
  const prNumber = await getPullRequestNumber();
  if (badgrMode === "health") {
    const jobsLog = await fetchAllJobsLog(token, repo, runId);
    const context2 = collectContext({
      provider: "github",
      repo,
      runId,
      runUrl: process.env.GITHUB_SERVER_URL ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}` : void 0,
      commitSha: process.env.GITHUB_SHA,
      branch: process.env.GITHUB_REF_NAME,
      log: jobsLog || "No job timing data available."
    });
    const report = await callBadgrCiHealth(context2, apiOptions);
    const markdown = renderHealthReport(report);
    await publishToSummary(markdown);
    return;
  }
  if (badgrMode === "audit") {
    const workflowYaml = await fetchWorkflowYaml(token, repo);
    const context2 = collectContext({
      provider: "github",
      repo,
      runId,
      runUrl: process.env.GITHUB_SERVER_URL ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}` : void 0,
      commitSha: process.env.GITHUB_SHA,
      branch: process.env.GITHUB_REF_NAME,
      log: workflowYaml ? `Workflow YAML:
${workflowYaml}` : "No workflow YAML available."
    });
    const report = await callBadgrCiAudit(context2, workflowYaml, apiOptions);
    const markdown = renderAuditReport(report);
    await publishToSummary(markdown);
    return;
  }
  if (badgrMode === "security") {
    const logs2 = await fetchFailedLogs(token, repo, runId);
    const context2 = collectContext({
      provider: "github",
      repo,
      runId,
      runUrl: process.env.GITHUB_SERVER_URL ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}` : void 0,
      commitSha: process.env.GITHUB_SHA,
      branch: process.env.GITHUB_REF_NAME,
      log: logs2.logSnippet || "No logs available."
    });
    const report = await callBadgrCiSecurity(context2, apiOptions);
    const markdown = renderSecurityReport(report);
    await publishToSummary(markdown);
    return;
  }
  const logs = await fetchFailedLogs(token, repo, runId);
  if (logs.setupError || !logs.logSnippet) {
    await publishToSummary(renderSetupErrorComment(logs.setupError || "No failed logs were available."));
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
  const diagnosis = await callBadgrCiDiagnose(context, apiOptions);
  const comment = renderCiComment(diagnosis);
  if (prNumber && shouldPostPrComment(outputMode))
    await upsertPrComment(token, repo, prNumber, comment);
  if (!prNumber || shouldPostSummary(outputMode) || !shouldPostPrComment(outputMode))
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
