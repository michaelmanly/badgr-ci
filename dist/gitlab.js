#!/usr/bin/env node

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

// packages/badgr-agent/dist/ci/gitlab/main.js
function glApiUrl() {
  return process.env.CI_API_V4_URL || "https://gitlab.com/api/v4";
}
async function gl(path, token, init = {}) {
  const response = await fetch(`${glApiUrl()}${path}`, {
    method: init.method ?? "GET",
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: init.body
  });
  if (!response.ok)
    throw new Error(`GitLab API ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${await response.text()}`);
  return await response.json();
}
async function fetchFailedLogs(token, projectId, pipelineId) {
  const jobs = await gl(`/projects/${encodeURIComponent(projectId)}/pipelines/${pipelineId}/jobs?per_page=100`, token);
  const failed = jobs.find((job) => ["failed", "canceled"].includes(job.status || ""));
  if (!failed)
    return { logSnippet: "", setupError: "No failed GitLab CI job found in this pipeline. Ensure GITLAB_TOKEN has read_api scope and the pipeline has failed jobs." };
  const logResponse = await fetch(`${glApiUrl()}/projects/${encodeURIComponent(projectId)}/jobs/${failed.id}/trace`, {
    headers: { "authorization": `Bearer ${token}` }
  });
  if (!logResponse.ok)
    return { failedJob: failed.stage, failedStep: failed.name, logSnippet: "", setupError: `Could not fetch GitLab job trace (HTTP ${logResponse.status}). Ensure GITLAB_TOKEN has read_api scope.` };
  return { failedJob: failed.stage, failedStep: failed.name, logSnippet: await logResponse.text() };
}
async function upsertMrNote(token, projectId, mrIid, markdown) {
  const base = `/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`;
  const notes = await gl(`${base}/notes?per_page=100&sort=asc`, token);
  const existing = findExistingBadgrComment(notes);
  if (existing) {
    await gl(`${base}/notes/${existing.id}`, token, { method: "PUT", body: JSON.stringify({ body: markdown }) });
  } else {
    await gl(`${base}/notes`, token, { method: "POST", body: JSON.stringify({ body: markdown }) });
  }
  return true;
}
function publishToConsole(markdown) {
  const ts = Math.floor(Date.now() / 1e3);
  console.log(`\x1B[0Ksection_start:${ts}:badgr-diagnosis[collapsed=true]\r\x1B[0KBadgr Agent CI`);
  console.log(markdown);
  console.log(`\x1B[0Ksection_end:${ts}:badgr-diagnosis\r\x1B[0K`);
}
async function run() {
  const apiKey = process.env.BADGR_API_KEY;
  const token = process.env.GITLAB_TOKEN;
  const projectId = process.env.CI_PROJECT_ID;
  const pipelineId = process.env.CI_PIPELINE_ID;
  if (!apiKey)
    throw new Error("BADGR_API_KEY is required. Add it as a masked CI/CD variable.");
  if (!token)
    throw new Error("GITLAB_TOKEN is required. Add a project access token with read_api and write_notes scopes as a masked variable.");
  if (!projectId || !pipelineId)
    throw new Error("CI_PROJECT_ID and CI_PIPELINE_ID are required. These are set automatically by GitLab CI.");
  const mrIid = process.env.CI_MERGE_REQUEST_IID;
  const logs = await fetchFailedLogs(token, projectId, pipelineId);
  if (logs.setupError || !logs.logSnippet) {
    const setupComment = renderSetupErrorComment(logs.setupError || "No failed logs were available.");
    if (mrIid) {
      try {
        await upsertMrNote(token, projectId, mrIid, setupComment);
        return;
      } catch {
      }
    }
    publishToConsole(setupComment);
    return;
  }
  const context = collectContext({
    provider: "gitlab",
    repo: process.env.CI_PROJECT_PATH,
    runId: pipelineId,
    runUrl: process.env.CI_PIPELINE_URL,
    commitSha: process.env.CI_COMMIT_SHA,
    branch: process.env.CI_COMMIT_REF_NAME,
    prNumber: mrIid ? Number(mrIid) : void 0,
    failedJob: logs.failedJob,
    failedStep: logs.failedStep,
    log: logs.logSnippet
  });
  const diagnosis = await callBadgrCiDiagnose(context, { apiUrl: process.env.BADGR_API_URL || "https://aibadgr.com/v1", apiKey });
  const comment = renderCiComment(diagnosis);
  if (mrIid) {
    try {
      await upsertMrNote(token, projectId, mrIid, comment);
      return;
    } catch {
    }
  }
  publishToConsole(comment);
}
if (process.env.BADGR_CI_NO_AUTO_RUN !== "1")
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
export {
  run
};
