import assert from 'node:assert/strict';
import { pass, fail, ROOT } from './helpers.mjs';
import { assessDailyCandidate } from '../lib/daily-candidate-assessor.mjs';

console.log('\ndaily candidate assessor — explicit evaluation gate');
async function check(label, fn) { try { await fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
const active = { application_ready: true, job_description: 'Kubernetes role', immigration: { blockers: [] } };
await check('verification failure prevents evaluation before any model request', async () => {
  let called = false;
  const result = await assessDailyCandidate({}, { root: ROOT, evaluate: true, verifyFn: async () => ({ application_ready: false, status: 'unverifiable', immigration: { blockers: [] } }), requestFn: async () => { called = true; } });
  assert.equal(result.decision, 'rejected_unverifiable'); assert.equal(called, false);
});
await check('active vacancy remains verification-only until --evaluate is explicitly enabled', async () => {
  const result = await assessDailyCandidate({}, { root: ROOT, evaluate: false, verifyFn: async () => active });
  assert.equal(result.decision, 'evaluation_disabled'); assert.equal(result.application_ready, true);
});
await check('Codex CLI result still passes deterministic threshold policy', async () => {
  let called = false;
  const evaluation = {
    schema_version: 1, match_score: 75,
    score_breakdown: { technical_stack: 25, responsibilities: 15, seniority_experience: 10, immigration_feasibility: 10, language: 10, relocation: 3, employment_arrangement: 2 },
    technical_matches: [{ requirement: 'Kubernetes', candidate_evidence: 'CV records Kubernetes experience' }], technical_gaps: [],
    immigration: { classification: 'unknown', evidence: [] }, language: { classification: 'compatible', evidence: [] },
    relocation: { classification: 'unknown', evidence: [] }, employment: { classification: 'employee', evidence: [] }, eligibility_blockers: [], uncertainties: ['Sponsorship not stated'],
  };
  const result = await assessDailyCandidate({ title: 'Platform Engineer', description: 'Kubernetes' }, {
    root: ROOT, evaluate: true, backend: 'codex-cli', verifyFn: async () => active,
    codexRequestFn: async () => { called = true; return { value: evaluation, model: 'codex-test', attempts: 1 }; },
  });
  assert.equal(called, true); assert.equal(result.accepted, true); assert.equal(result.decision, 'accepted_pending_verification');
});
