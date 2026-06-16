# auto-continue-on-429

A Claude Code plugin that auto-resumes a task when a turn stops right after a rate-limit / 429 error.

## How it actually works (important)

Claude Code has **no "API returned 429" hook event**. HTTP errors happen below the
plugin layer, so a plugin cannot directly listen for a 429.

This plugin approximates it with the **`Stop` hook**, which fires every time Claude
finishes a turn. On each stop it:

1. Reads only the **new** bytes of the session transcript since the last check.
2. Continues **only if** that new text contains both an error signal
   (`error`, `failed`, `interrupted`, `overloaded`, …) **and** a rate-limit signal
   (`429`, `rate limit`, `too many requests`, `retry-after`, …).
3. If matched, it blocks the stop and feeds Claude an English instruction to resume
   the task where it left off.

If a turn was cut short by a 429 and the error surfaced in the transcript, the next
stop picks it up and continues. If the 429 aborts the CLI before anything is written,
the hook never runs — that case needs an external wrapper, not a plugin.

## Loop guards

- Honors `stop_hook_active` — never continues while already inside a continue.
- Tracks a per-session byte offset, so an old 429 line can't retrigger forever.
- Requires an error keyword **and** a rate-limit keyword to both match.
- Caps auto-continues at 5 per session (`MAX_CONTINUES_PER_SESSION` in the script).

## Install

```
/plugin marketplace add <your-github-user>/<repo>
/plugin install auto-continue-on-429@claudenext-plugins
```

## Requirements

`node` on PATH (the Stop hook runs `scripts/check-429.js`).
