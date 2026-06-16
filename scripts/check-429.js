#!/usr/bin/env node
"use strict";

/*
 * Stop hook for the auto-continue-on-429 plugin.
 *
 * Claude Code fires the Stop hook every time the assistant finishes a turn.
 * There is no "API returned 429" event, so we approximate it: when Claude
 * stops, we scan the NEW portion of the session transcript. If that new
 * portion shows both an error signal AND a rate-limit signal, we block the
 * stop and feed Claude an English "continue" instruction so it resumes the
 * task automatically.
 *
 * Safeguards against runaway loops:
 *   1. Honor stop_hook_active — if we are already inside a continue, bail.
 *   2. Only scan transcript bytes added since our last run (per session),
 *      so an old 429 marker can't retrigger forever.
 *   3. Require an error keyword AND a rate-limit keyword to both match.
 *   4. Cap the number of auto-continues per session.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_CONTINUES_PER_SESSION = 5;
const CONTINUE_MESSAGE =
  "It looks like the previous turn was interrupted by a rate limit (HTTP 429). " +
  "Please continue exactly where you left off and finish the task. Do not restart from scratch.";

// Match an error/interruption signal.
const ERROR_RE = /\b(error|failed|interrupted|overloaded|exception|aborted)\b/i;
// Match a rate-limit signal (429 or common phrasings).
const RATE_LIMIT_RE =
  /(\b429\b|rate[\s_-]?limit|too many requests|rate.limited|quota exceeded|retry[\s_-]?after)/i;

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

// Allow Claude to stop normally: emit nothing, exit 0.
function allowStop() {
  process.exit(0);
}

// Block the stop and tell Claude to continue.
function forceContinue(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    allowStop();
  }

  // Already continuing from a prior stop hook — never loop.
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

  // Transcript was truncated/rotated — reset our cursor.
  if (size < state.offset) {
    state.offset = 0;
  }

  // Read only the bytes added since last time.
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

  // Advance the cursor regardless of outcome so we never rescan old content.
  state.offset = size;

  const hitRateLimit = RATE_LIMIT_RE.test(chunk) && ERROR_RE.test(chunk);

  if (hitRateLimit && state.continues < MAX_CONTINUES_PER_SESSION) {
    state.continues += 1;
    saveState(sessionId, state);
    forceContinue(CONTINUE_MESSAGE);
  }

  saveState(sessionId, state);
  allowStop();
}

main();
