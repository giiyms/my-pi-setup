---
name: efficient-harness
description: Token-efficient coding with hashline edits, compressed tool output, advisor, and debug tools from efficient-harness.
---

# Efficient harness workflow

Use this skill for everyday coding when `efficient-harness` is loaded (hashline on by default).

## Read

- Large files come back as a **SUMMARY** (outline + head/tail).
- Before editing, call `read` with `full=true` **or** a tight `offset`/`limit` window to get **hashline** anchors:
  ```
     12:a3f|  return value;
  ```
- Anchors are `line:hash`. Hashes change if the line content changes.

## Edit

- Use the `edit` tool with ops that reference anchors — never retype entire old lines.
- Ops:
  - `replace` — `start` / optional `end` + `text`
  - `insert_after` — `start` + `text`
  - `delete` — `start` / optional `end`
- If you get **stale anchor**, re-read that window once and retry. Do not invent hashes.

## Search (sibling extension)

- Prefer **`fd`** (paths) and **`rg`** (content) from the file-search extension over bash find/grep.
- Results are capped and token-efficient.

## Diagnostics (LSP)

- After edits, call `lsp` with `path` to the file (or enable `--auto-lsp`).
- Prefer this over full project builds when checking a single file.
- Engines: typescript-language-server, pyright, rust-analyzer, clangd.

## Subagents (sibling extension)

- Use **`subagent_spawn` / `subagent_wait` / `subagent_check`** from the subagents extension so the parent context stays small.
- Prefer explore-style prompts for investigation; only spawn implement work when edits should be isolated.

## Debug

- Crashes / wrong runtime values: `debug` tool
  - Native: `action=lldb_run` or `lldb_cmds` with `program` + `breakpoint`
  - Node: `action=node_inspect` then `kill` when done
- `action=help` for the full surface.

## Advisor

- `/advisor on` — second model pass injects notes after turns
- `/advisor once` — review last turn now
- Treat `blocker` notes as must-fix; answer concerns before claiming done.

## Token hygiene

- Keep bash output small; the harness auto-compresses huge tool results.
- Prefer range reads over whole-file dumps.
- Use `/checkpoint my-label` before risky refactors.
- Smart compaction (structured Goal/Decisions/Files/Next) runs on session compact unless `--no-smart-compact`.
