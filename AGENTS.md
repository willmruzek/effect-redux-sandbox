# Effect development

This project vendors Effect source under `repos/effect/` as a squashed Git
subtree. It is read-only reference material, not application code.

- Before writing or modifying Effect code, read [Effect's guide](repos/effect/LLMS.md).
- Inspect `repos/effect/packages/effect/src/`, its tests, and `repos/effect/ai-docs/`
  for idiomatic usage, API signatures, and patterns rather than guessing.
- The subtree is pinned to Effect 4.1.2. Use examples matching the app's installed
  Effect version; update the subtree when upgrading the dependency.
- Do not edit files under `repos/` unless explicitly requested.
- Import from normal package dependencies (`effect`), never from `repos/`.
- Do not include vendored repositories in application builds, tests, or linting.
- See [README.md](README.md) for workspace commands and subtree maintenance.
