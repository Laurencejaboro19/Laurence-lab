import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Smoke test for the scaffold: proves the test runner works and pins the
// contract that every required npm script exists. Later phases add real tests.
const REQUIRED_SCRIPTS = [
  'dev',
  'build',
  'start',
  'test',
  'lint',
  'typecheck',
  'migrate',
  'seed',
  'verify',
] as const;

describe('scaffold', () => {
  it('defines every npm script the owner was promised', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of REQUIRED_SCRIPTS) {
      expect(pkg.scripts[name], `missing script "${name}"`).toBeTypeOf('string');
    }
  });
});
