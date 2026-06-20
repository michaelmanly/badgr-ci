#!/usr/bin/env node

// packages/badgr-agent/dist/ci/k8s/main.js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

// packages/badgr-agent/dist/ci/k8s/main.js
var execFileAsync = promisify(execFile);
async function runKubectl(args) {
  const { stdout, stderr } = await execFileAsync("kubectl", args, { timeout: 3e4 });
  return stdout + (stderr ? `
--- stderr ---
${stderr}` : "");
}
async function collectK8sLogs(opts = {}) {
  const nsFlag = opts.namespace ? ["--namespace", opts.namespace] : ["--all-namespaces"];
  const parts = [];
  try {
    const raw = await runKubectl(["get", "events", "--field-selector=type=Warning", "--sort-by=.lastTimestamp", ...nsFlag, "-o", "json"]);
    const parsed = JSON.parse(raw);
    const lines = (parsed.items || []).slice(-30).map((e) => `[${e.lastTimestamp || ""}] ${e.involvedObject?.kind}/${e.involvedObject?.name}: ${e.reason} \u2014 ${e.message}`);
    if (lines.length > 0)
      parts.push(`=== Recent Warning Events ===
${lines.join("\n")}`);
  } catch {
    parts.push("=== Warning Events: unavailable ===");
  }
  let failedPodName;
  let failedContainer;
  try {
    const raw = await runKubectl(["get", "pods", ...nsFlag, "-o", "json"]);
    const parsed = JSON.parse(raw);
    const unhealthy = (parsed.items || []).filter((pod) => {
      const phase = pod.status?.phase;
      const cstatuses = pod.status?.containerStatuses || [];
      return phase === "Failed" || cstatuses.some((s) => !s.ready || (s.restartCount ?? 0) > 2 || s.state?.waiting?.reason === "CrashLoopBackOff" || s.state?.waiting?.reason === "ImagePullBackOff" || s.state?.waiting?.reason === "ErrImagePull");
    });
    if (unhealthy.length > 0) {
      const pod = unhealthy[0];
      failedPodName = pod.metadata?.name;
      failedContainer = pod.status?.containerStatuses?.find((s) => !s.ready || (s.restartCount ?? 0) > 0)?.name;
      for (const p of unhealthy.slice(0, 3)) {
        try {
          const desc = await runKubectl(["describe", "pod", p.metadata?.name || "", ...nsFlag]);
          parts.push(`=== Describe Pod: ${p.metadata?.name} ===
${desc.slice(0, 3e3)}`);
        } catch {
        }
      }
    }
  } catch {
    parts.push("=== Pod Status: unavailable ===");
  }
  if (failedPodName) {
    const logBase = ["logs", failedPodName, "--tail=200", ...nsFlag];
    if (failedContainer)
      logBase.push("--container", failedContainer);
    const tried = await (async () => {
      try {
        return await runKubectl([...logBase, "--previous"]);
      } catch {
      }
      try {
        return await runKubectl(logBase);
      } catch {
        return null;
      }
    })();
    parts.push(tried ? `=== Pod Logs: ${failedPodName} ===
${tried}` : `=== Pod Logs: unavailable for ${failedPodName} ===`);
  }
  if (opts.selector) {
    try {
      const logs = await runKubectl(["logs", `-l${opts.selector}`, "--tail=200", ...nsFlag]);
      parts.push(`=== Selector Logs (${opts.selector}) ===
${logs}`);
    } catch {
    }
  }
  if (parts.length === 0)
    return { logSnippet: "", setupError: "No failed or unhealthy pods found. Ensure kubectl is configured and you have the correct namespace." };
  return { failedJob: opts.namespace || "default", failedStep: failedPodName, logSnippet: parts.join("\n\n") };
}
async function run(opts = {}) {
  const apiKey = process.env.BADGR_API_KEY;
  if (!apiKey)
    throw new Error("BADGR_API_KEY is required. Set it as an environment variable: export BADGR_API_KEY=<your-key>");
  const namespace = opts.namespace || process.env.BADGR_K8S_NAMESPACE;
  const selector = opts.selector || process.env.BADGR_K8S_SELECTOR;
  const logs = await collectK8sLogs({ namespace, selector });
  if (logs.setupError || !logs.logSnippet) {
    console.log(renderSetupErrorComment(logs.setupError || "No failed Kubernetes workloads found."));
    return;
  }
  const context = collectContext({
    provider: "kubernetes",
    repo: process.env.BADGR_K8S_CLUSTER,
    runId: logs.failedStep,
    failedJob: logs.failedJob,
    failedStep: logs.failedStep,
    log: logs.logSnippet
  });
  const diagnosis = await callBadgrCiDiagnose(context, { apiUrl: process.env.BADGR_API_URL || "https://aibadgr.com/v1", apiKey });
  console.log(renderCiComment(diagnosis));
}
if (process.env.BADGR_CI_NO_AUTO_RUN !== "1") {
  const argv = process.argv.slice(2);
  const namespace = argv.find((a) => a.startsWith("--namespace="))?.split("=")[1];
  const selector = argv.find((a) => a.startsWith("--selector="))?.split("=")[1];
  run({ namespace, selector }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
export {
  collectK8sLogs,
  run,
  runKubectl
};
