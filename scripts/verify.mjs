#!/usr/bin/env node
// One command that runs every check and prints a clear PASS/FAIL table.
// This is the command to run before every merge and in CI: `npm run verify`.
//
// Each step is a separate child process so that one failure never hides the
// others — the owner sees everything that is wrong in a single run.
import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'typecheck', cmd: 'npm', args: ['run', '--silent', 'typecheck'] },
  { name: 'lint', cmd: 'npm', args: ['run', '--silent', 'lint'] },
  { name: 'secrets', cmd: 'npm', args: ['run', '--silent', 'secrets:scan'] },
  { name: 'test', cmd: 'npm', args: ['run', '--silent', 'test'] },
];

const results = [];
for (const step of steps) {
  const started = Date.now();
  process.stdout.write(`\n=== ${step.name} ===\n`);
  const r = spawnSync(step.cmd, step.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  results.push({ name: step.name, ok: r.status === 0, ms: Date.now() - started });
}

process.stdout.write('\n==================== VERIFY SUMMARY ====================\n');
let allOk = true;
for (const r of results) {
  allOk &&= r.ok;
  const status = r.ok ? 'PASS' : 'FAIL';
  process.stdout.write(`${status.padEnd(5)} ${r.name.padEnd(12)} ${String(r.ms).padStart(6)} ms\n`);
}
process.stdout.write('========================================================\n');
process.stdout.write(allOk ? 'RESULT: PASS\n' : 'RESULT: FAIL\n');
process.exit(allOk ? 0 : 1);
