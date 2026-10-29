import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pass, fail, ROOT } from './helpers.mjs';
import { buildCodexEvaluationPrompt, requestCodexStructuredEvaluation } from '../lib/codex-cli-evaluator.mjs';

console.log('\ncodex CLI evaluator — ephemeral, read-only structured output');
async function check(label, fn) { try { await fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
await check('prompt contains only supplied candidate and verified-vacancy data with safety constraints', () => {
  const prompt = buildCodexEvaluationPrompt({ job: { title: 'Platform Engineer', description: 'Kubernetes work' }, cvText: 'CV fact', profileText: 'Profile fact' });
  assert.match(prompt, /Do not browse, run commands, edit files, submit applications/);
  assert.match(prompt, /CV fact/); assert.match(prompt, /Kubernetes work/);
});
await check('invokes codex exec ephemerally with read-only sandbox and output schema', async () => {
  let received;
  const result = await requestCodexStructuredEvaluation({ root: ROOT, prompt: 'evaluate', schema: { type: 'object' }, execFileFn: async (_cmd, args) => {
    received = args;
    const outputPath = args[args.indexOf('--output-last-message') + 1];
    writeFileSync(outputPath, '{"ok":true}\n');
  } });
  assert.equal(result.value.ok, true);
  assert.deepEqual(received.slice(0, 5), ['exec', '--ephemeral', '--sandbox', 'read-only', '--output-schema']);
  const schemaPath = received[received.indexOf('--output-schema') + 1];
  assert.equal(existsSync(schemaPath), false, 'temporary schema must be removed after run');
});
