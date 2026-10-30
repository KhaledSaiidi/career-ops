import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pass, fail } from './helpers.mjs';
import { dailyExitCode, summarizeDailyRun, writeDailyRunReport } from '../lib/daily-report.mjs';

console.log('\ndaily report — auditable run outcomes');
function check(label, fn) { try { fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
const accepted = { company: 'Example', title: 'Platform Engineer', country: 'Netherlands', location: 'Amsterdam', application_url: 'https://jobs.example.test/1', assessment: { evaluation: { match_score: 82, technical_matches: [{ requirement: 'Kubernetes' }], technical_gaps: ['Go'] }, verification: { immigration: { classification: 'unknown', evidence: [] }, posting_date: { value: null, status: 'unknown' } } } };
check('records shortfall, rejection counters, and strongest opportunities', () => {
  const summary = summarizeDailyRun({ report: { run_id: 'fixture', accepted: [accepted], rejected: [{ reason: 'rejected_below_threshold' }, { reason: 'already_processed' }, { reason: 'rejected_confirmed_eligibility_blocker' }], attempts: [{ number: 1, stage: 'normal_discovery', discovered: 4, sources: [{ id: 'source', status: 'ok' }] }], processed: 4, shortfall: 4 } });
  assert.equal(summary.counters.discovered, 4); assert.equal(summary.counters.rejected_below_75, 1); assert.equal(summary.counters.rejected_duplicates, 1);
  assert.equal(summary.strongest[0].match_score, 82); assert.equal(summary.country_breakdown.Netherlands, 1);
});
check('writes JSON and Markdown reports under a Tunisia-local day', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-report-'));
  try {
    const result = writeDailyRunReport(root, { report: { run_id: 'report-fixture', accepted: [], rejected: [], attempts: [], shortfall: 5 } }, { now: new Date('2026-10-29T23:30:00Z') });
    assert.equal(existsSync(result.json_path), true); assert.match(result.markdown_path, /2026-10-30/);
    assert.match(readFileSync(result.markdown_path, 'utf8'), /shortfall: 5/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
check('maps operational outcomes to stable exit codes', () => {
  assert.equal(dailyExitCode({ error: new Error('GOOGLE_APPLICATION_CREDENTIALS is required') }), 2);
  assert.equal(dailyExitCode({ summary: { counters: { sheet_failed: 1 } } }), 5);
  assert.equal(dailyExitCode({ summary: { attempts: [{ sources: [{ status: 'error' }] }], counters: { sheet_failed: 0 } } }), 3);
  assert.equal(dailyExitCode({ summary: { attempts: [], counters: { sheet_failed: 0 } } }), 0);
});
