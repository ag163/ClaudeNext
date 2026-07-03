#!/usr/bin/env node
"use strict";

/*
 * Stop hook for auto-continue-on-429.
 *
 * Codex stores transcripts as JSONL. Never scan raw transcript JSON because
 * normal user messages, assistant explanations, tool output, test fixtures, and
 * hook prompts can legitimately contain "429" / "rate limit" text. For JSONL
 * transcripts, inspect only explicit error-like events. If the transcript is
 * not JSONL, fall back to raw text for Claude Code compatibility.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MAX_CONTINUES_PER_SESSION = 5;
const CONTINUE_MESSAGE =
  "The previous turn appears to have hit a temporary provider limit. " +
  "Please continue exactly where you left off and finish the task. Do not restart from scratch.";

const ERROR_RE = /\b(error|failed|interrupted|overloaded|exception|aborted|failure|unavailable)\b/i;
const RATE_LIMIT_RE =
  /(\b429\b|rate[\s_-]?limit|too many requests|rate.limited|quota exceeded|retry[\s_-]?after|throttled)/i;
const SELF_CONTINUE_MESSAGE_RE =
  /(?:It looks like the previous turn was interrupted by a rate limit \(HTTP 429\)\.\s*|The previous turn appears to have hit a temporary provider limit\.\s*)Please continue exactly where you left off and finish the task\. Do not restart from scratch\./g;
const HOOK_PROMPT_RE = /<hook_prompt\b[\s\S]*?<\/hook_prompt>/g;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function stateDir() {
  const base =
    process.env.CLAUDE_PLUGIN_DATA ||
    process.env.CODEX_PLUGIN_DATA ||
    path.join(os.tmpdir(), "claude-auto-continue-429");
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {
    /* ignore */
  }
  return base;
}

function stateFileFor(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(stateDir(), `${safe}.json`);
}

function loadState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFileFor(sessionId), "utf8"));
  } catch {
    return { offset: 0, continues: 0 };
  }
}

function saveState(sessionId, state) {
  try {
    fs.writeFileSync(stateFileFor(sessionId), JSON.stringify(state), "utf8");
  } catch {
    /* ignore */
  }
}

function claimContinueOnce(sessionId, transcriptPath, size) {
  const key = crypto
    .createHash("sha256")
    .update(`${sessionId || "unknown"}|${transcriptPath || "unknown"}|${size || 0}`)
    .digest("hex");
  const dir = path.join(os.tmpdir(), "auto-continue-on-429-locks");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(path.join(dir, `${key}.lock`), "wx");
    fs.writeFileSync(fd, String(Date.now()), "utf8");
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function allowStop() {
  process.exit(0);
}

function forceContinue(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function cleanText(text) {
  return String(text || "")
    .replace(HOOK_PROMPT_RE, "")
    .replace(SELF_CONTINUE_MESSAGE_RE, "");
}

function payloadLooksErrorLike(payload) {
  if (!payload || typeof payload !== "object") return false;
  const type = String(payload.type || "").toLowerCase();
  const level = String(payload.level || payload.severity || "").toLowerCase();
  if (type.includes("error") || type.includes("failure")) return true;
  if (level === "error" || level === "fatal") return true;
  return false;
}

function rateLimitReachedPayload(payload) {
  const rateLimits = payload && payload.rate_limits;
  if (!rateLimits || typeof rateLimits !== "object") return false;
  const reachedType = String(rateLimits.rate_limit_reached_type || "").trim().toLowerCase();
  if (reachedType && reachedType !== "none" && reachedType !== "null" && reachedType !== "false") {
    return true;
  }
  return Boolean(rateLimits.limit_reached || rateLimits.exceeded || rateLimits.retry_after);
}

function extractSignalTextFromJsonLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { parsed: false, text: "" };
  }

  const topType = String(entry && entry.type ? entry.type : "").toLowerCase();
  const payload = entry && entry.payload;

  if (topType.includes("error")) {
    return { parsed: true, text: cleanText(JSON.stringify(entry)) };
  }

  if (payloadLooksErrorLike(payload)) {
    return { parsed: true, text: cleanText(JSON.stringify(payload)) };
  }

  // Codex token_count events carry structured rate limit metadata. Trigger only
  // when Codex says a limit was actually reached, not merely because the field
  // name "rate_limits" exists in every token_count event.
  if (payload && payload.type === "token_count" && rateLimitReachedPayload(payload)) {
    return { parsed: true, text: "error rate limit 429 " + cleanText(JSON.stringify(payload.rate_limits)) };
  }

  return { parsed: true, text: "" };
}

function signalChunkFromTranscriptChunk(chunk) {
  const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
  let parsedJsonLines = 0;
  const signals = [];

  for (const line of lines) {
    const result = extractSignalTextFromJsonLine(line);
    if (result.parsed) parsedJsonLines += 1;
    if (result.text) signals.push(result.text);
  }

  if (parsedJsonLines > 0) {
    return signals.join("\n");
  }

  // Claude Code / older tools may provide a non-JSON transcript. Keep the old
  // heuristic only for that case.
  return cleanText(chunk);
}

function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    allowStop();
  }

  if (payload.stop_hook_active) {
    allowStop();
  }

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    allowStop();
  }

  const state = loadState(sessionId);

  let size = 0;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    allowStop();
  }

  if (size < state.offset) {
    state.offset = 0;
  }

  let chunk = "";
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const len = size - state.offset;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.offset);
      chunk = buf.toString("utf8");
    }
    fs.closeSync(fd);
  } catch {
    allowStop();
  }

  state.offset = size;

  const signalChunk = signalChunkFromTranscriptChunk(chunk);
  const hitRateLimit = RATE_LIMIT_RE.test(signalChunk) && ERROR_RE.test(signalChunk);

  if (hitRateLimit && state.continues < MAX_CONTINUES_PER_SESSION) {
    if (!claimContinueOnce(sessionId, transcriptPath, size)) {
      saveState(sessionId, state);
      allowStop();
    }
    state.continues += 1;
    saveState(sessionId, state);
    forceContinue(CONTINUE_MESSAGE);
  }

  saveState(sessionId, state);
  allowStop();
}

main();

