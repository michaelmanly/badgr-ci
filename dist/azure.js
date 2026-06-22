#!/usr/bin/env node

// packages/badgr-agent/dist/ci/azure/main.js
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

// packages/badgr-agent/dist/ci/azure/main.js
function azureToken() {
  return process.env.SYSTEM_ACCESSTOKEN;
}
function collectionUrl() {
  return process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI || "";
}
function project() {
  return process.env.SYSTEM_TEAMPROJECT || "";
}
function repoId() {
  return process.env.BUILD_REPOSITORY_ID || process.env.BUILD_REPOSITORY_NAME;
}
function buildId() {
  return process.env.BUILD_BUILDID;
}
async function az(url, token, init = {}) {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: init.body
  });
  if (!response.ok)
    throw new Error(`Azure DevOps API ${init.method ?? "GET"} failed with HTTP ${response.status}: ${await response.text()}`);
  return await response.json();
}
async function fetchFailedLogs(token) {
  const base = `${collectionUrl()}${project()}`;
  const id = buildId();
  if (!base || !id)
    return { logSnippet: "", setupError: "Azure build identifiers were unavailable." };
  const timeline = await az(`${base}/_apis/build/builds/${id}/timeline?api-version=7.1-preview.2`, token);
  const failed = timeline.records?.find((record) => ["failed", "canceled"].includes((record.result || "").toLowerCase()) && record.log?.id);
  if (!failed?.log?.id)
    return { logSnippet: "", setupError: "No failed Azure task log was found. Ensure the task runs after a failure and System.AccessToken is enabled." };
  const logResponse = await fetch(`${base}/_apis/build/builds/${id}/logs/${failed.log.id}?api-version=7.1-preview.2`, { headers: { "authorization": `Bearer ${token}` } });
  if (!logResponse.ok)
    return { failedStep: failed.name, logSnippet: "", setupError: `Could not fetch Azure task logs (HTTP ${logResponse.status}). Enable \u201CAllow scripts to access OAuth token\u201D.` };
  return { failedJob: failed.type, failedStep: failed.name, logSnippet: await logResponse.text() };
}
async function publishSummary(markdown) {
  const dir = await mkdtemp(join(tmpdir(), "badgr-ci-"));
  const file = join(dir, "summary.md");
  await writeFile(file, markdown, "utf8");
  console.log(`##vso[task.addattachment type=Distributedtask.Core.Summary;name=Badgr Agent CI;]${file}`);
}
function azurePrId() {
  return process.env.SYSTEM_PULLREQUEST_PULLREQUESTID || process.env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER;
}
async function upsertPrThread(token, markdown) {
  const prId = azurePrId();
  const repositoryId = repoId();
  if (!prId || !repositoryId)
    return false;
  const base = `${collectionUrl()}${project()}`;
  const listUrl = `${base}/_apis/git/repositories/${repositoryId}/pullRequests/${prId}/threads?api-version=7.1-preview.1`;
  const threads = await az(listUrl, token);
  const existing = findExistingBadgrComment((threads.value || []).map((thread) => ({
    ...thread,
    body: thread.comments?.map((comment) => comment.content || "").join("\n"),
    badgrCommentId: thread.comments?.find((comment) => comment.content?.includes(BADGR_MARKER) || comment.content?.includes(BADGR_MARKER_LEGACY))?.id
  })));
  if (existing?.id) {
    const commentId = existing.badgrCommentId ?? 1;
    const updateUrl = `${base}/_apis/git/repositories/${repositoryId}/pullRequests/${prId}/threads/${existing.id}/comments/${commentId}?api-version=7.1-preview.1`;
    await az(updateUrl, token, { method: "PATCH", body: JSON.stringify({ content: markdown }) });
  } else {
    await az(listUrl, token, { method: "POST", body: JSON.stringify({ comments: [{ parentCommentId: 0, content: markdown, commentType: 1 }], status: 1 }) });
  }
  return true;
}
async function fetchAllTasksLog(token) {
  const base = `${collectionUrl()}${project()}`;
  const id = buildId();
  if (!base || !id)
    return "";
  try {
    const timeline = await az(`${base}/_apis/build/builds/${id}/timeline?api-version=7.1-preview.2`, token);
    const parts = [];
    for (const rec of timeline.records || []) {
      if (rec.type !== "Task")
        continue;
      const start = rec.startTime ? new Date(rec.startTime) : null;
      const finish = rec.finishTime ? new Date(rec.finishTime) : null;
      const dur = start && finish ? Math.round((finish.getTime() - start.getTime()) / 1e3) : null;
      parts.push(`Task: ${rec.name} (${rec.result ?? "unknown"}) ${dur !== null ? `${dur}s` : ""}`);
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}
async function fetchPipelineYaml(_token) {
  return void 0;
}
async function run() {
  const apiKey = process.env.BADGR_API_KEY;
  const token = azureToken();
  const outputMode = getOutputMode();
  const badgrMode = getBadgrMode();
  if (!apiKey)
    throw new Error("BADGR_API_KEY is required. Add it as a secret variable.");
  if (!token)
    throw new Error("SYSTEM_ACCESSTOKEN is required. Enable 'Allow scripts to access OAuth token' for the Azure pipeline/task.");
  const apiOptions = { apiUrl: process.env.BADGR_API_URL || DEFAULT_API_URL, apiKey };
  const runUrl = collectionUrl() && project() && buildId() ? `${collectionUrl()}${project()}/_build/results?buildId=${buildId()}` : void 0;
  if (badgrMode === "health") {
    const tasksLog = await fetchAllTasksLog(token);
    const context2 = collectContext({
      provider: "azure",
      repo: process.env.BUILD_REPOSITORY_NAME,
      runId: buildId(),
      runUrl,
      commitSha: process.env.BUILD_SOURCEVERSION,
      branch: process.env.BUILD_SOURCEBRANCHNAME,
      log: tasksLog || "No task timing data available."
    });
    const report = await callBadgrCiHealth(context2, apiOptions);
    const markdown = renderHealthReport(report);
    await publishSummary(markdown);
    return;
  }
  if (badgrMode === "audit") {
    const workflowYaml = await fetchPipelineYaml(token);
    if (!workflowYaml) {
      await publishSummary(`${BADGR_MARKER}
### Badgr Agent CI \u2014 Pipeline Audit

Pipeline YAML is not available via the Azure DevOps API. Audit mode requires the pipeline definition to be readable. This is a known limitation of Azure Pipelines \u2014 consider storing your pipeline YAML in source control and fetching it via the repository API.
`);
      return;
    }
    const context2 = collectContext({
      provider: "azure",
      repo: process.env.BUILD_REPOSITORY_NAME,
      runId: buildId(),
      runUrl,
      commitSha: process.env.BUILD_SOURCEVERSION,
      branch: process.env.BUILD_SOURCEBRANCHNAME,
      log: `Pipeline YAML:
${workflowYaml}`
    });
    const report = await callBadgrCiAudit(context2, workflowYaml, apiOptions);
    await publishSummary(renderAuditReport(report));
    return;
  }
  if (badgrMode === "security") {
    const logs2 = await fetchFailedLogs(token);
    const context2 = collectContext({
      provider: "azure",
      repo: process.env.BUILD_REPOSITORY_NAME,
      runId: buildId(),
      runUrl,
      commitSha: process.env.BUILD_SOURCEVERSION,
      branch: process.env.BUILD_SOURCEBRANCHNAME,
      log: logs2.logSnippet || "No logs available."
    });
    const report = await callBadgrCiSecurity(context2, apiOptions);
    const markdown = renderSecurityReport(report);
    await publishSummary(markdown);
    return;
  }
  const logs = await fetchFailedLogs(token);
  if (logs.setupError || !logs.logSnippet) {
    await publishSummary(renderSetupErrorComment(logs.setupError || "No failed logs were available."));
    return;
  }
  const context = collectContext({
    provider: "azure",
    repo: process.env.BUILD_REPOSITORY_NAME,
    runId: buildId(),
    runUrl,
    commitSha: process.env.BUILD_SOURCEVERSION,
    branch: process.env.BUILD_SOURCEBRANCHNAME,
    failedJob: logs.failedJob,
    failedStep: logs.failedStep,
    log: logs.logSnippet
  });
  const diagnosis = await callBadgrCiDiagnose(context, apiOptions);
  const comment = renderCiComment(diagnosis);
  if (shouldPostPrComment(outputMode)) {
    const posted = await upsertPrThread(token, comment);
    if (posted && !shouldPostSummary(outputMode))
      return;
  }
  await publishSummary(comment);
}
if (process.env.BADGR_CI_NO_AUTO_RUN !== "1")
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
export {
  run
};
