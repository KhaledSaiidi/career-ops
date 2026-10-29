import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pass, fail } from './helpers.mjs';
import { hasProcessed, markProcessed, readDailyRunStore, writeDailyRunStore } from '../lib/daily-run-store.mjs';

console.log('\ndaily run store — durable dedup and migration');
function check(label, fn) { try { fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
check('writes atomically and restores all equivalent keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-daily-store-'));
  try {
    const file = join(dir, 'state.json');
    const state = readDailyRunStore(file);
    markProcessed(state, { primary: 'url:https://example.test/job?jobId=1', keys: ['url:https://example.test/job?jobId=1', 'requisition:example:req-1'] }, { decision: 'accepted' });
    writeDailyRunStore(file, state);
    const restored = readDailyRunStore(file);
    assert.equal(restored.version, 2); assert.equal(hasProcessed(restored, { keys: ['requisition:example:req-1'] }), true);
    assert.equal(existsSync(`${file}.${process.pid}.tmp`), false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).processed['url:https://example.test/job?jobId=1'].decision, 'accepted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
check('upgrades version-one state without discarding processed entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-daily-store-'));
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ version: 1, processed: { legacy: { decision: 'rejected' } }, runs: {} }));
    const migrated = readDailyRunStore(file);
    assert.equal(migrated.version, 2); assert.equal(hasProcessed(migrated, 'legacy'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
