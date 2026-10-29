import assert from 'node:assert/strict';
import { pass, fail } from './helpers.mjs';
import { runProgressiveSearch } from '../lib/progressive-search.mjs';

console.log('\nprogressive search — bounded target pursuit and restart safety');
async function check(label, fn) { try { await fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
const config = { country_effort: { Netherlands: 35, France: 25, Belgium: 10, Denmark: 10, Luxembourg: 10, Sweden: 10 }, target: { minimum_qualified_jobs: 5, preferred_qualified_jobs_max: 5 }, discovery: { initial_posting_age_days: 7, expanded_posting_age_days: 30, maximum_posting_age_days: 90 } };
const job = (id, accepted = true) => ({ url: `https://jobs.example.test/${id}`, company: 'Example', title: 'Platform Engineer', assessment: { accepted, application_ready: accepted, decision: accepted ? 'accepted_pending_verification' : 'rejected_below_threshold' } });

await check('three qualifying jobs force the next discovery stage', async () => {
  const stages = [];
  const { report } = await runProgressiveSearch({ config, discover: async (stage) => { stages.push(stage.name); return stage.number === 1 ? { candidates: [job(1), job(2), job(3)], sources: ['fixture'] } : stage.number === 2 ? { candidates: [job(4), job(5)], sources: ['fixture'] } : { candidates: [] }; }, assess: async (candidate) => candidate.assessment });
  assert.equal(report.accepted.length, 5); assert.deepEqual(stages, ['normal_discovery', 'expand_sources']);
});
await check('five qualifying jobs stop expansion at the preferred target', async () => {
  const { report } = await runProgressiveSearch({ config, discover: async () => ({ candidates: [job(1), job(2), job(3), job(4), job(5)], sources: ['fixture'] }), assess: async (candidate) => candidate.assessment });
  assert.equal(report.attempts.length, 1); assert.equal(report.shortfall, 0);
});
await check('exhaustion with three writes a precise two-job shortfall and restart skips processed candidates', async () => {
  const state = { version: 1, processed: {}, runs: {} };
  const first = await runProgressiveSearch({ config, state, maxStages: 8, discover: async (stage) => stage.number === 1 ? { candidates: [job(1), job(2), job(3)], sources: ['fixture'] } : { candidates: [], sources: ['fixture'] }, assess: async (candidate) => candidate.assessment });
  assert.equal(first.report.shortfall, 2); assert.equal(first.report.exhausted, true);
  const second = await runProgressiveSearch({ config, state: first.state, maxStages: 1, discover: async () => ({ candidates: [job(1)], sources: ['fixture'] }), assess: async () => { throw new Error('must not re-evaluate'); } });
  assert.equal(second.report.processed, 0); assert.equal(second.report.rejected[0].reason, 'already_processed');
  assert.equal(second.report.stopped_by_budget, true);
});
