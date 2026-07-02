# ClaudeNext

ClaudeNext Auto Next For 429 Stop

A Claude Code / Codex plugin (`auto-continue-on-429`) that auto-resumes a task when a turn stops right after a rate-limit / 429 error.

## How it actually works (important)

Claude Code has **no "API returned 429" hook event**. HTTP errors happen below the
plugin layer, so a plugin cannot directly listen for a 429.

This plugin approximates it with the **`Stop` hook**, which fires every time Claude
finishes a turn. On each stop it:

1. Reads only the **new** portion of the session transcript since the last check.
2. Looks for an **error signal** AND a **rate-limit signal** (e.g. `429`,
   `rate limit`, `too many requests`) both present in that new portion.
3. If matched, it **blocks the stop** and feeds Claude an English instruction to
   continue the task where it left off.

### Loop guards

- Honors `stop_hook_active` so a continue can't trigger another continue.
- Only scans transcript bytes added since the last run (an old 429 marker can't
  retrigger forever).
- Requires both an error keyword and a rate-limit keyword to match.
- Caps auto-continues per session (default 5).

## Install

### Claude Code

```
/plugin marketplace add mcxiedidi/ClaudeNext
/plugin install auto-continue-on-429@claudenext-plugins
```

### Codex

This fork also includes a Codex manifest at `.codex-plugin/plugin.json`.

If you publish this fork as a marketplace source, add it to Codex:

```bash
codex plugin marketplace add ag163/ClaudeNext
```

Then restart Codex, open `/plugins`, install **Auto Continue on 429**, and review/trust the bundled hook when Codex prompts you.

## Requirements

`node` on PATH (the Stop hook runs `scripts/check-429.js`).
