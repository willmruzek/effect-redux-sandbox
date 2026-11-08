---
name: readable-code
description: 'Use when writing, editing, refactoring, or reviewing code. Improve readability with intentional whitespace and logical grouping of related imports, declarations, expressions, and operations, independent of language, framework, or architecture.'
---

# Readable Code

Keep code easy to scan. Prefer intentional whitespace and clear logical groups
over compressed declarations or densely packed operations. Apply these rules to
new and edited code; when reviewing, point out nearby compression that directly
obscures the changed behavior.

## Layout rules

1. **Keep imports scannable.** Put one imported name per line when an
   import has several names and the language supports it. Group imports by
   origin or responsibility; use a blank line between groups. Do not combine
   unrelated imports just to save lines.
2. **Group by responsibility.** Keep related variables, derived values,
   helpers, and operations together. Separate distinct concerns with one blank
   line. Keep operations serving the same concern together rather than
   interleaving unrelated work.
3. **Give meaningful operations room.** Use multiline bodies for functions,
   callbacks, and control flow with multiple steps. Put each meaningful operation
   on its own line. Split long conditions across lines by condition.
4. **Expand dense object literals.** When an object has several properties or
   represents structured data, place properties on separate lines and group
   related fields together. Keep genuinely tiny objects inline when that is
   clearer.
5. **Use consistent vertical rhythm.** Separate top-level declarations,
   logical blocks, and groups of related operations with a single blank line. Avoid both
   wall-of-code blocks and excessive blank lines between adjacent statements.
6. **Keep names and order informative.** Declare related values and helpers
   near their use, and order similar operations consistently. Preserve execution
   order when regrouping code could change behavior.
   Prefer named intermediate values when they clarify a multi-step condition or
   transformation.

## Example

Prefer:

```ts
const trimmedName = name.trim();
const hasName = trimmedName.length > 0;
const fitsLimit = trimmedName.length <= maximumNameLength;

if (!hasName || !fitsLimit) {
  return;
}

const displayName = trimmedName.toUpperCase();
const label = `${prefix}: ${displayName}`;

return label;
```

Avoid compressing validation, transformation, and output into a dense block
on one line. The point is not to maximize line count; keep short expressions
inline when they remain easy to scan.

## Workflow

1. Read the surrounding module and preserve its established naming, types, and
   behavior.
2. Identify logical groups before editing; keep related declarations and
   operations together, preserve execution order, and keep similar operations
   visually consistent.
3. Format changed code using the layout rules above. Do not reformat unrelated
   files or large untouched sections as a side effect.
4. Review the diff for accidental behavior changes and verify with the
   repository's relevant tests, type-check, and lint commands.

Whitespace and grouping must not hide behavior or replace a needed structural
refactor. Do not add comments or abstractions solely to decorate a block, and
do not change behavior as part of a formatting-only cleanup.
