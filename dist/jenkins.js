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

// packages/badgr-agent/dist/ci/jenkins/main.js
async function fetchConsoleLog(buildUrl, user, token) {
  const headers = {};
  if (user && token)
    headers["authorization"] = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
  const logResponse = await fetch(`${buildUrl}consoleText`, { headers });
  if (!logResponse.ok)
    return { logSnippet: "", setupError: `Could not fetch Jenkins console log (HTTP ${logResponse.status}). Ensure JENKINS_USER and JENKINS_TOKEN are set with read permission.` };
  const jobName = process.env.JOB_NAME;
  const buildNumber = process.env.BUILD_NUMBER;
  return { failedJob: jobName, failedStep: buildNumber ? `Build #${buildNumber}` : void 0, logSnippet: await logResponse.text() };
}
async function upsertGitHubComment(token, repo, prNumber, markdown) {
  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  const headers = { "authorization": `Bearer ${token}`, "accept": "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" };
  const listResp = await fetch(`${apiBase}/repos/${repo}/issues/${prNumber}/comments?per_page=100`, { headers });
  if (!listResp.ok)
    return false;
  const comments = await listResp.json();
  const existing = findExistingBadgrComment(comments);
  if (existing) {
    await fetch(`${apiBase}/repos/${repo}/issues/comments/${existing.id}`, { method: "PATCH", headers, body: JSON.stringify({ body: markdown }) });
  } else {
    await fetch(`${apiBase}/repos/${repo}/issues/${prNumber}/comments`, { method: "POST", headers, body: JSON.stringify({ body: markdown }) });
  }
  return true;
}
async function upsertGitLabNote(token, projectId, mrIid, markdown) {
  const apiBase = process.env.GITLAB_API_URL || "https://gitlab.com/api/v4";
  const headers = { "authorization": `Bearer ${token}`, "content-type": "application/json" };
  const base = `${apiBase}/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`;
  const listResp = await fetch(`${base}/notes?per_page=100&sort=asc`, { headers });
  if (!listResp.ok)
    return false;
  const notes = await listResp.json();
  const existing = findExistingBadgrComment(notes);
  if (existing) {
    await fetch(`${base}/notes/${existing.id}`, { method: "PUT", headers, body: JSON.stringify({ body: markdown }) });
  } else {
    await fetch(`${base}/notes`, { method: "POST", headers, body: JSON.stringify({ body: markdown }) });
  }
  return true;
}
function publishToConsole(markdown) {
  console.log("\n==================== Badgr Agent CI ====================");
  console.log(markdown);
  console.log("=========================================================\n");
}
function parseRepoFromGitUrl(gitUrl) {
  if (!gitUrl)
    return void 0;
  try {
    return new URL(gitUrl).pathname.replace(/^\/|\.git$/g, "");
  } catch {
    return void 0;
  }
}
async function run() {
  const apiKey = process.env.BADGR_API_KEY;
  const buildUrl = process.env.BUILD_URL;
  if (!apiKey)
    throw new Error("BADGR_API_KEY is required. Add it as a Jenkins credential and inject via environment().");
  if (!buildUrl)
    throw new Error("BUILD_URL is required. This is set automatically by Jenkins in pipeline and freestyle jobs.");
  const logs = await fetchConsoleLog(buildUrl, process.env.JENKINS_USER, process.env.JENKINS_TOKEN);
  if (logs.setupError || !logs.logSnippet) {
    publishToConsole(renderSetupErrorComment(logs.setupError || "No console log was available."));
    return;
  }
  const changeId = process.env.CHANGE_ID;
  const context = collectContext({
    provider: "jenkins",
    repo: parseRepoFromGitUrl(process.env.GIT_URL),
    runId: process.env.BUILD_NUMBER,
    runUrl: buildUrl,
    commitSha: process.env.GIT_COMMIT,
    branch: process.env.GIT_BRANCH,
    prNumber: changeId ? Number(changeId) : void 0,
    failedJob: logs.failedJob,
    failedStep: logs.failedStep,
    log: logs.logSnippet
  });
  const diagnosis = await callBadgrCiDiagnose(context, { apiUrl: process.env.BADGR_API_URL || "https://aibadgr.com/v1", apiKey });
  const comment = renderCiComment(diagnosis);
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo = process.env.GITHUB_REPO;
  if (githubToken && githubRepo && changeId) {
    if (await upsertGitHubComment(githubToken, githubRepo, Number(changeId), comment))
      return;
  }
  const gitlabToken = process.env.GITLAB_TOKEN;
  const gitlabProjectId = process.env.GITLAB_PROJECT_ID;
  if (gitlabToken && gitlabProjectId && changeId) {
    if (await upsertGitLabNote(gitlabToken, gitlabProjectId, changeId, comment))
      return;
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
