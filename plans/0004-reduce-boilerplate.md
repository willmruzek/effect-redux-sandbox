# 0004: Reduce boilerplate

**Status: IMPLEMENTED**

## Goal

Reduce repeated request and UI plumbing in both tracker apps while establishing
patterns other applications can follow. Keep core stores usable independently
of optional toolkits, and keep app reducers, workflows and runtime ownership
explicit.

## Inherits and adds

Inherit the workspace and core stores from
[0001](0001-original-project-plan.md), matching CRUD behavior from
[0002](0002-base-crud.md), and optional slice/normalized-request foundations
from [0003](0003-additional-layers.md).

This final stage removes repeated plumbing and clarifies registration boundaries.
It introduces the generated CRUD lifecycle runners, metadata inference, separate
reducer registration and field/domain/UI helpers described below. It preserves
the preceding feature scope; deferred or removed roadmap features stay excluded.

## Completed stages

### 1. Transport-neutral request lifecycles

- Consolidate request ownership, execution and settlement mechanics into the
  two optional toolkit packages.
- Generate started, confirmed and failed actions for CRUD workflows, with the
  same mechanism supporting the mixed-mode people read.
- Keep GraphQL/REST transport selection and domain transitions outside the
  generic lifecycle machinery.
- Treat `createAsyncThunk`, rather than an entity adapter, as the conceptual
  analogy; retain Effect execution in both apps.

### 2. Runner metadata and inferred payloads

- Let runners generate request IDs and failure messages.
- Supply original domain input plus an execution callback.
- Pass saved data separately as `result`, without rebuilding lifecycle
  metadata at every call site.
- Infer generated action payloads instead of maintaining duplicate types.

### 3. Explicit reducer registration

- Separate CRUD lifecycle definitions and runners from reducer installation.
- Separate normalized query/mutation definitions from reducer installation.
- Offer optional guarded case reducers; explicitly register every case.
- Allow handwritten handlers and independent observers.
- Fail explicitly when execution starts without a registered ownership claim.
- Keep Effect execution in the Effect core and Redux execution in middleware;
  that difference is intentional.

### 4. Typed optimistic-field reducers

- Provide optional helpers for status, priority and assignee transitions.
- Capture original values, apply optimism, accept authoritative saved values
  and restore originals with visible errors on failure.
- Keep pending accessors, start eligibility and case registration explicit.
- Do not let changed start eligibility prevent an existing write settling.
- Retain domain-specific creation, deletion and detail-merge reducers.

### 5. Reusable input and result contracts

- Replace repeated inline input shapes with named shared domain contracts.
- Use `TaskFieldInput<Value>` for status, priority and nullable assignees.
- Reuse domain entity/value result types; keep lifecycle payloads inferred.

### 6. State-derived UI metadata

- Let `ProjectTracker` derive source mode, people request status, creation
  notices and deletions from `TrackerViewState`.
- Remove duplicate metadata props from both app adapters.
- Share data contracts without sharing reducers or runtime ownership.

### 7. Shared domain validation

- Consolidate missing-task, draft, deletion and pending-save rules in pure
  validators in `packages/project-tracker`.
- Include assignee reference validation.
- Return either the validated task or an explicit user-facing error.
- Let both apps independently surface failures before transport or optimism
  across GraphQL, REST and mixed modes.
- Preserve existing messages, check precedence and independent field saves.
- Keep toolkit ownership guards distinct from domain eligibility.
- Keep backend validation authoritative and separate from client preflight.
- Leave creation retry and person rename validation in their existing workflows.

## Guardrails

- Keep separate Redux and Effect app workflows and toolkit implementations.
- Reducer state and outputs contain data only.
- Do not introduce entity adapters, Redux-only thunks or compatibility wrappers
  merely to reduce line count.
- Preserve injected persistence, explicit refresh, rollback, stale-response
  guards and SSR/navigation ownership.
- Keep public APIs strongly typed without casts or lint suppressions.
- Take one commit-sized improvement at a time and write focused tests first.
- Follow the [readable-code skill](../.agents/skills/readable-code/SKILL.md)
  without adding formatting dependencies.

## Completion checks

- All seven stages above are implemented in both apps where applicable.
- Focused tests cover domain rules, request ownership and UI state contracts.
- Both apps preserve behavior across GraphQL, REST and mixed modes.
- Workspace tests, type-check, lint and production builds pass.
- Documentation explains the core/toolkit/domain/workflow boundaries.

At completion of shared domain validation, all 454 workspace tests passed,
along with lint, type-check and production builds. This is a historical
validation result for this stage, not a promise about future changes.

[0007](0007-generated-api-reducers.md) explicitly revises this stage's normalized
request registration contract: install a generated API reducer once and compose
separate domain reducers before it. Standalone write lifecycle case registration
and application-owned domain state remain unchanged.
