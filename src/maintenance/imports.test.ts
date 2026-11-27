import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The maintenance program must run when the program is broken, for example when node_modules/ is
 * missing (chapter 7.5). So everything that src/maintenance/main.ts reaches imports only builtins
 * of Node.js and files of this repository. This test walks that graph. Type-only imports are
 * dropped by the compiler, so it reads each file as the compiler writes it.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(SRC, 'maintenance', 'main.ts');

interface Found {
  specifier: string;
  kind: 'static' | 'dynamic' | 'require';
}

function importsOf(file: string, source = readFileSync(file, 'utf8')): Found[] {
  const js = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;
  const found: Found[] = [];
  const sf = ts.createSourceFile(file, js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, kind: 'static' });
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        found.push({ specifier: arg !== undefined && ts.isStringLiteral(arg) ? arg.text : '<computed>', kind: 'dynamic' });
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0];
        found.push({ specifier: arg !== undefined && ts.isStringLiteral(arg) ? arg.text : '<computed>', kind: 'require' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every file that the entry reaches, and every import that breaks the rule. */
function walk(entry: string): { files: string[]; problems: string[] } {
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const where = relative(SRC, file);
    for (const f of importsOf(file)) {
      if (f.kind !== 'static') {
        problems.push(`${where}: ${f.kind === 'dynamic' ? 'import()' : 'require()'} of ${f.specifier}`);
        continue;
      }
      if (f.specifier.startsWith('node:')) continue;
      if (!f.specifier.startsWith('./') && !f.specifier.startsWith('../')) {
        problems.push(`${where}: imports the package ${f.specifier}`);
        continue;
      }
      const target = resolve(dirname(file), f.specifier.replace(/\.js$/, '.ts'));
      if (!target.startsWith(SRC + '/')) {
        problems.push(`${where}: imports ${f.specifier}, outside src/`);
        continue;
      }
      queue.push(target);
    }
  }
  return { files: [...seen].map((f) => relative(SRC, f)).sort(), problems };
}

describe('the imports of the maintenance program', () => {
  it('reaches only builtins of Node.js and files of this repository, with no import() or require()', () => {
    const { files, problems } = walk(ENTRY);
    expect(problems).toEqual([]);
    // The walk reached the parts it must check.
    for (const f of ['maintenance/cli.ts', 'maintenance/update.ts', 'maintenance/repair.ts', 'maintenance/install.ts', 'maintenance/serve.ts']) {
      expect(files).toContain(f);
    }
    expect(files.some((f) => f.startsWith('harness/') || f.startsWith('run/') || f.startsWith('db/'))).toBe(false);
  });

  it('holds for the self-heal too, which the program runs when its own packages may be broken', () => {
    expect(walk(join(SRC, 'maintenance', 'heal.ts')).problems).toEqual([]);
  });

  it('finds a package import, an import() and a require(), and drops a type-only import', () => {
    const probe = (text: string) => importsOf(join(SRC, 'maintenance', 'probe.ts'), text);
    expect(probe("import { parse } from 'yaml'; export const x = parse;")).toEqual([{ specifier: 'yaml', kind: 'static' }]);
    expect(probe("export { parse } from 'yaml';")).toEqual([{ specifier: 'yaml', kind: 'static' }]);
    expect(probe("export const x = () => import('./cli.js');")).toEqual([{ specifier: './cli.js', kind: 'dynamic' }]);
    expect(probe("const name = 'yaml'; export const x = () => import(name);")).toEqual([{ specifier: '<computed>', kind: 'dynamic' }]);
    expect(probe("declare const require: (n: string) => unknown; export const x = require('yaml');")).toEqual([{ specifier: 'yaml', kind: 'require' }]);
    expect(probe("import type { Document } from 'yaml'; export const x: Document | undefined = undefined;")).toEqual([]);
  });
});
