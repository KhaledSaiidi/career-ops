import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pass, fail, ROOT, SANDBOX_DATA_ROOT } from './helpers.mjs';
import { runProgressiveSearch } from '../lib/progressive-search.mjs';
import { summarizeDailyRun } from '../lib/daily-report.mjs';
import { main as runDailyDiscovery, parseDailySourceArgs } from '../daily-discovery.mjs';

console.log('\ndaily discovery E2E — deterministic acceptance and no-apply safety');
async function check(label, fn) { try { await fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
const config = { country_effort: { Netherlands: 35, France: 25, Belgium: 10, Denmark: 10, Luxembourg: 10, Sweden: 10 }, target: { minimum_qualified_jobs: 5, preferred_qualified_jobs_max: 5 }, discovery: { initial_posting_age_days: 7, expanded_posting_age_days: 30, maximum_posting_age_days: 90 } };
const candidate = (id, assessment) => ({ company: `Example ${id}`, employer_legal_name: `Example ${id}`, title: 'Platform Engineer', country: 'Netherlands', location: 'Amsterdam', application_url: `https://jobs.example.test/${id}`, assessment });
const eligible = (score = 75) => ({ accepted: score >= 75, application_ready: true, decision: score >= 75 ? 'accepted_pending_verification' : 'rejected_below_threshold', evaluation: { match_score: score } });

await check('74 is not exported, 75 is accepted, and a confirmed blocker wins over 95', async () => {
  const low = candidate('low', eligible(74));
  const pass75 = candidate('pass', eligible(75));
  const blocked = candidate('blocked', { ...eligible(95), accepted: false, application_ready: false, decision: 'rejected_confirmed_eligibility_blocker' });
  const { report } = await runProgressiveSearch({ config, maxStages: 1, discover: async () => ({ candidates: [low, pass75, blocked], sources: [{ id: 'fixture', status: 'ok' }] }), assess: async (item) => item.assessment });
  assert.equal(report.accepted.length, 1); assert.equal(report.accepted[0].assessment.evaluation.match_score, 75);
  assert.deepEqual(report.rejected.map((entry) => entry.reason).sort(), ['rejected_below_threshold', 'rejected_confirmed_eligibility_blocker']);
  const summary = summarizeDailyRun({ report });
  assert.equal(summary.counters.rejected_below_75, 1); assert.equal(summary.counters.rejected_eligibility_blocker, 1);
});
await check('three valid jobs keep the controller searching and report the exact shortfall when exhausted', async () => {
  const jobs = [candidate(1, eligible()), candidate(2, eligible()), candidate(3, eligible())];
  const { report } = await runProgressiveSearch({ config, maxStages: 8, discover: async (stage) => stage.number === 1 ? { candidates: jobs, sources: [{ id: 'fixture', status: 'ok' }] } : { candidates: [], sources: [{ id: 'fixture', status: 'ok' }] }, assess: async (item) => item.assessment });
  assert.equal(report.accepted.length, 3); assert.equal(report.shortfall, 2); assert.equal(report.exhausted, true);
});
await check('daily runner does not import application or submission code paths', () => {
  const source = readFileSync(`${ROOT}/daily-discovery.mjs`, 'utf8');
  assert.doesNotMatch(source, /prepare-application|application-artifacts|submitApplication|\.click\(.*submit/i);
});
await check('accepts exactly one live source selector before starting discovery', () => {
  assert.deepEqual(parseDailySourceArgs(['--live-scan']), { fixturePath: null, liveScan: true });
  assert.throws(() => parseDailySourceArgs([]), /Choose exactly one source/);
});
await check('CLI awaits its async run and emits persistent report artifacts', async () => {
  const configDir = join(SANDBOX_DATA_ROOT, 'config'); mkdirSync(configDir, { recursive: true });
  copyFileSync(join(ROOT, 'config', 'daily-discovery.yml'), join(configDir, 'daily-discovery.yml'));
  const fixturePath = join(SANDBOX_DATA_ROOT, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify({ normal_discovery: { candidates: [candidate('cli', eligible())], sources: [{ id: 'fixture', status: 'ok' }] } }));
  const originalRoot = process.env.CAREER_OPS_ROOT;
  try {
    process.env.CAREER_OPS_ROOT = SANDBOX_DATA_ROOT;
    await runDailyDiscovery(['--fixture', fixturePath, '--max-stages', '1']);
    const reportDir = join(SANDBOX_DATA_ROOT, 'output', 'daily-runs');
    assert.equal(existsSync(reportDir), true);
  } finally { process.env.CAREER_OPS_ROOT = originalRoot; }
});
