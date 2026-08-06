---
name: agent-council
description: "Use when a task needs multi-model perspectives, brainstorming, or stress-testing. Collaborative (default) or adversarial debate. Triggers: council, siege, swarm, multi-agent, debate, brainstorm. Port of Sentry01/AgentCouncil for pi subagents."
---

# Agent Council (pi)

Dispatch **3 subagents on different harnesses** in parallel, then synthesize as the parent orchestrator.

Based on [Sentry01/AgentCouncil](https://github.com/Sentry01/AgentCouncil), adapted to pi’s `subagent_spawn` tools.

**Core principle:** Three model families catch blind spots. Mode chooses cooperate vs compete.

## Seat → harness map (this environment)

| Seat | Role | Harness | Default model hint | Effort |
|------|------|---------|--------------------|--------|
| **Alpha** | Deep Explorer / Drafter | `claude` | `fable` | `high` |
| **Beta** | Practical Builder / Validator | `codex` | `gpt-5.6-sol` | `high` |
| **Gamma** | Elegant Minimalist / Devil’s Advocate | `gemini` (Antigravity `agy`) | `gemini-3.1-pro-high` (default) | — |
| **Orchestrator** | Synthesizer / Judge | **you (parent)** | current session model | — |

Keep Alpha/Beta/Gamma on **different families**. If a harness is unavailable, drop that seat rather than duplicating a family. Max **4** concurrent subagents — council uses 3.

## When to use

- User says council / siege / swarm / multi-agent / debate / brainstorm
- Architecture, security, research, high-stakes design
- Explicit multi-model request

**Do not use** for trivial one-liners, file lookups, or pure speed tasks unless the user forces a council.

## Mode detection

**Adversarial** if message has: debate, adversarial, challenge, stress-test, which is better, argue, attack, defend, versus, vs  
**Collaborative** (default): council, siege, swarm, brainstorm, multi-agent, collaborate, explore, novel, creative, ideas  
Explicit `adversarial council:` / `collaborative council:` always wins. If both sets appear, adversarial wins unless overridden.

## Verbosity

- Default: show **only final** synthesis/verdict
- `verbose` / show debate / show council → short phase summaries
- `raw` / `full` → include full drafts

## Complexity gate

Skip the council and answer directly when the task is trivial (arithmetic, one-line rewrite, syntax lookup, single obvious path).

---

## Collaborative mode (default)

### Phase 1 — Draft (parallel, all 3)

Spawn simultaneously:

```text
subagent_spawn harness=claude model=fable reasoning_effort=high name="Alpha draft"
subagent_spawn harness=codex model=gpt-5.6-sol reasoning_effort=high name="Beta draft"
subagent_spawn harness=gemini model=gemini-3.1-pro-high name="Gamma draft"
```

**Alpha prompt skeleton:**
```
You are Alpha on an Agent Council (Collaborative). Role: deep, creative exploration.
TASK: {task}
Working directory: {cwd}
Instructions:
1. Thorough response; mark major claims HIGH/MEDIUM/LOW confidence
2. ## Open Questions
3. ## Wild Ideas (at least one unconventional approach)
Under 1500 words. Self-contained — no parent context.
```

**Beta prompt skeleton:**
```
You are Beta on an Agent Council (Collaborative). Role: practical, grounded builder.
TASK: {task}
Working directory: {cwd}
Instructions:
1. Practical validated approaches; confidence tags
2. ## Building Blocks
3. ## Combinations
Under 1500 words. Self-contained.
```

**Gamma prompt skeleton:**
```
You are Gamma on an Agent Council (Collaborative). Role: elegant minimalist.
TASK: {task}
Working directory: {cwd}
Instructions:
1. Simplest viable approach; confidence tags
2. ## Alternative Angles (≥2 reframes)
3. ## What If
Under 1500 words. Self-contained.
```

Then `subagent_wait` on all three ids (or wait for auto-delivery if you can continue other work first — prefer wait before improve).

### Phase 2 — Improve (parallel, all 3)

Spawn **new** agents (same harness/model each) with the other two drafts inlined:

```
You are {Agent} (Collaborative — Improve).
ORIGINAL TASK: {task}
YOUR DRAFT: {own}
OTHER DRAFTS: {other1} {other2}
Write an IMPROVED answer better than any solo draft. Steal best ideas; note novel synthesis.
Under 1500 words.
```

Wait again.

### Phase 3 — Synthesize (you)

Read all three improved drafts. **Author** the final answer (do not merely pick a winner). Lead with the actionable result; put dissent/risks briefly at the end if needed.

---

## Adversarial mode

### Phase 1 — Draft (parallel)

Same three harnesses, adversarial role prompts:

- **Alpha:** thorough draft + ## Self-Critique  
- **Beta:** independent solution + ## Validation Notes (CRITICAL/IMPORTANT/MINOR)  
- **Gamma:** elegant alternative + ## Devil's Advocate  

### Phase 1.5 — Triage (you)

Full consensus (same core approach, no CRITICAL flags, no key contradictions, mostly HIGH confidence) → skip attacks, go to verdict.

Else pick a **leader** by: correctness/evidence, coverage, actionability, unresolved risk severity, calibrated confidence.

### Phase 2 — Attack (parallel, non-leaders)

Spawn the two non-leader harnesses to attack the leader’s position hard (factual errors, edge cases, hidden costs). Under 1000 words each.

### Phase 3 — Verdict (you)

Deliver SURVIVED / MODIFIED / OVERTURNED with the final battle-tested answer.

---

## Operational rules

1. Prompts must be **self-contained** (paths, constraints, cwd). Children cannot see this chat.
2. Prefer `subagent_wait` before improve/attack/synthesize so order is correct.
3. Inspect live runs with `/subagents`.
4. If `gemini`/agy unavailable (not on PATH / not logged in), run a 2-seat council (claude+codex) and say so.
5. Do not spawn recursive councils inside children.
6. After final answer, do not dump all drafts unless verbose/raw.

## User triggers (examples)

```
council: Should we use a monorepo?
debate: Redis vs Memcached for sessions
verbose council: caching strategy for realtime dashboard
```
