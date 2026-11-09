---
name: write-plan
description: 'Use whenever asked to write, create, draft, or make an implementation plan, or to make an existing plan development-ready. Investigate the project, interview the user one question at a time, and write a decision-complete plan that can be implemented without further product or design choices.'
---

# Write a development-ready plan

The first written draft should be ready for development, not a list of
unresolved decisions. Investigate first, then resolve consequential choices
with the user before writing the plan. Do not start implementation unless
the user separately requests it.

## 1. Understand the work

- Read relevant instructions, existing plans, documentation, code and tests.
  Trace the affected behavior and ownership boundaries instead of guessing.
- Identify the goal, current behavior, affected surfaces, dependencies,
  compatibility concerns and meaningful alternatives.
- Separate facts established by the repository from recommendations and
  choices only the user can make. Do not present an assumption as an
  agreed decision.
- Follow the repository's plan location, numbering, title and status
  conventions. Ask if a material scope or location choice remains unclear.

## 2. Interview before drafting

- Ask one focused question at a time using the available question tool. Wait
  for the answer before asking the next question. Include the relevant
  context, practical options, trade-offs and your recommendation when useful.
- Adapt follow-ups to the user's answers. Cover every consequential choice
  needed for implementation: scope, behavior, edge cases, failure and
  cancellation, concurrency, data and resource ownership, compatibility,
  migration, dependencies, and user experience where applicable.
- Do not ask the user to decide facts discoverable in the repository. Do not
  ask about irrelevant cases or demand decisions already made.
- If plans depend on one another, resolve prerequisite contracts first. Do not
  claim a downstream plan is ready if its implementation depends on an
  unresolved upstream interface or behavior.
- If the user declines to decide, cancels, or an external dependency prevents
  resolution, stop and explain the blocker. Do not write or label an
  incomplete plan as development-ready. Respect an explicit request for a
  provisional or exploratory plan, and clearly label it as such.

## 3. Write the plan

Once choices are resolved, write a first draft that includes, as applicable:

- Goal, scope and explicit non-goals; current behavior and affected surfaces.
- The agreed behavior and concrete contract, including interfaces, data
  ownership, lifecycle, failure handling and relevant edge cases.
- Prerequisites, integration and migration steps, compatibility decisions,
  and how existing behavior is preserved or intentionally changed.
- A test-first implementation sequence, focused verification commands and
  measurable acceptance criteria tied to the agreed behavior.

Be specific enough that another developer can implement and verify the plan
without choosing product behavior or inventing architecture. Leave normal
coding details to implementation; avoid artificial precision and unnecessary
code. Do not add a generic open-decisions section to a development-ready plan.
Update directly related plan indexes or roadmap links when appropriate.

## 4. Check readiness

Before presenting the plan, review it against the user's answers, the actual
codebase and the following questions:

1. Can each implementation stage proceed in dependency order?
2. Are consequential choices, failure modes, ownership and migration resolved?
3. Are acceptance criteria observable and tests sufficient to distinguish
   success from a plausible but incomplete implementation?
4. Are there contradictions, unsupported assumptions or unresolved blockers?

If any answer is no, investigate or ask the next question before finalizing.
Summarize the finished plan and any explicit constraints without claiming
implementation has already been completed.
