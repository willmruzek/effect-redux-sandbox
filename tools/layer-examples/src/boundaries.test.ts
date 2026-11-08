import { readFileSync } from 'node:fs';
import {
  describe,
  expect,
  test,
} from 'vitest';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);

function dependencyNames(relativePath: string): readonly string[] {
  const manifest: unknown = JSON.parse(readFileSync(new URL(relativePath, root), 'utf8'));

  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('name' in manifest) ||
    typeof manifest.name !== 'string'
  ) {
    throw new Error(`Invalid package manifest: ${relativePath}`);
  }

  if (!('dependencies' in manifest))
    return [];

  if (typeof manifest.dependencies !== 'object' || manifest.dependencies === null)
    throw new Error(`Invalid dependency contract: ${relativePath}`);

  return Object.keys(manifest.dependencies);
}

function imports(relativePath: string): readonly string[] {
  const text = readFileSync(new URL(relativePath, root), 'utf8');
  const source = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true);

  return source.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

describe('package dependency direction', () => {
  test('Effect core depends on neither toolkits nor tracker code', () => {
    // Arrange: inspect the actual production package contract.
    const dependencies = dependencyNames('../packages/effect-store/package.json');

    // Act: select internal workspace dependencies.
    const internal = dependencies.filter((name) => name.startsWith('@repo/'));

    // Assert: the core can be consumed without workspace domain or toolkit packages.
    expect(internal).toEqual([]);
  });

  test.each(['effect-store-toolkit', 'redux-toolkit', 'gql-api'])(
    '%s depends on neither applications nor tracker packages',
    (name) => {
      // Arrange: each request layer declares its own production dependencies.
      const dependencies = dependencyNames(`../packages/${name}/package.json`);

      // Act: select its internal dependency edges.
      const internal = dependencies.filter((dependency) => dependency.startsWith('@repo/'));

      // Assert: only the store-independent transport layer is an allowed edge.
      expect(internal.every((dependency) => dependency === '@repo/gql-api')).toBe(true);
    },
  );
});

describe('consumer source boundaries', () => {
  test('core example imports no optional toolkit', () => {
    // Arrange: inspect imports in the executable core example.
    const dependencies = imports('layer-examples/src/core.ts');

    // Act: select its library dependencies.
    const libraries = dependencies.filter((name) => !name.startsWith('.'));

    // Assert: plain Redux and Effect core are sufficient.
    expect(libraries.sort()).toEqual(['@repo/effect-store', 'effect', 'redux']);
  });

  test('slice example imports no request helper', () => {
    // Arrange: inspect the optional slice composition.
    const text = readFileSync(new URL('layer-examples/src/slices.ts', root), 'utf8');
    const source = ts.createSourceFile('slices.ts', text, ts.ScriptTarget.Latest, true);

    // Act: identify names imported from the Effect toolkit.
    const toolkitImports = source.statements.flatMap((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== '@repo/effect-store-toolkit'
      ) {
        return [];
      }

      const bindings = statement.importClause?.namedBindings;

      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => element.name.text)
        : [];
    });

    // Assert: requesting a slice does not require defining an API or lifecycle.
    expect(toolkitImports).toEqual(['createSlice']);
  });

  test.each(['core', 'slices', 'effectRequests', 'reduxRequests', 'inventory'])(
    '%s uses public exports without app or tracker imports',
    (name) => {
      // Arrange: load the example's source imports.
      const dependencies = imports(`layer-examples/src/${name}.ts`);

      // Act: find source-path or tracker dependencies.
      const violations = dependencies.filter((dependency) =>
        dependency.includes('/src/') ||
        dependency.includes('apps/') ||
        dependency.includes('project-tracker') ||
        dependency.includes('tracker-graphql'),
      );

      // Assert: a second consumer domain is not coupled to the original demo.
      expect(violations).toEqual([]);
    },
  );
});
