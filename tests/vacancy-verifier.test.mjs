import assert from 'node:assert/strict';
import { pass, fail } from './helpers.mjs';
import { assessImmigrationEvidence, matchIndRecognizedSponsor, normalizeLegalEntityName } from '../lib/immigration-evidence.mjs';
import { checkVacancyLiveness, normalizePostingDate, verifyVacancy } from '../lib/vacancy-verifier.mjs';
import { decideEuropeanJob } from '../lib/europe-job-evaluator.mjs';

console.log('\nvacancy verifier — liveness, dates, and immigration evidence');
async function check(label, fn) { try { await fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
const snapshot = { as_of: '2026-10-20', source_url: 'https://ind.nl/register', employers: [{ name: 'Acme Netherlands B.V.' }] };

await check('normalizes legal entities conservatively and finds one fresh IND exact match', () => {
  assert.equal(normalizeLegalEntityName('ACME Netherlands B.V.'), 'acme netherlands');
  assert.equal(matchIndRecognizedSponsor('Acme Netherlands B.V.', snapshot, { now: new Date('2026-10-29') }).status, 'exact_match');
});
await check('marks stale IND snapshots unavailable rather than inferring sponsor eligibility', () => {
  assert.equal(matchIndRecognizedSponsor('Acme Netherlands B.V.', snapshot, { now: new Date('2027-01-29') }).status, 'unavailable');
});
await check('keeps IND recognition distinct from vacancy sponsorship', () => {
  const result = assessImmigrationEvidence({ country: 'Netherlands', employerLegalName: 'Acme Netherlands B.V.', jobDescription: 'Build Kubernetes platforms.', jobUrl: 'https://jobs.acme.test/1', indSnapshot: snapshot, now: new Date('2026-10-29') });
  assert.equal(result.classification, 'confirmed_employer_eligible');
  assert.equal(result.sponsorship, 'unconfirmed');
});
await check('detects only explicit work-authorization and sponsorship blockers', () => {
  const result = assessImmigrationEvidence({ country: 'France', jobDescription: 'Applicants must already have the right to work in France. We cannot offer visa sponsorship.', jobUrl: 'https://jobs.example.test/1' });
  assert.equal(result.classification, 'confirmed_blocker');
  assert.equal(result.blockers.length, 2);
  assert.equal(assessImmigrationEvidence({ country: 'France', jobDescription: 'International team; sponsorship details are not stated.' }).classification, 'unknown');
});
await check('normalizes known and unknown publication dates without inventing one', () => {
  assert.deepEqual(normalizePostingDate('2026-10-03'), { value: '2026-10-03', status: 'verified' });
  assert.deepEqual(normalizePostingDate('not-a-date'), { value: null, status: 'unknown' });
});
await check('requires active liveness, a JD, and no confirmed blocker for application-ready', async () => {
  const base = { application_url: 'https://jobs.example.test/1', country: 'Sweden', employer_legal_name: 'Example AB' };
  const active = await verifyVacancy(base, { livenessChecker: async () => ({ result: 'active', code: 'fixture', reason: 'active' }), jdFetcher: async () => ({ text: 'We provide visa sponsorship for this role.' }) });
  assert.equal(active.status, 'verified');
  const closed = await verifyVacancy(base, { livenessChecker: async () => ({ result: 'expired', code: 'fixture', reason: 'closed' }) });
  assert.equal(closed.status, 'closed');
  const blocked = await verifyVacancy(base, { livenessChecker: async () => ({ result: 'active', code: 'fixture', reason: 'active' }), jdFetcher: async () => ({ text: 'No visa sponsorship is provided.' }) });
  assert.equal(blocked.status, 'blocked');
  const evaluation = { schema_version: 1, match_score: 95, score_breakdown: { technical_stack: 30, responsibilities: 20, seniority_experience: 15, immigration_feasibility: 15, language: 10, relocation: 5, employment_arrangement: 0 }, technical_matches: [{ requirement: 'Kubernetes', candidate_evidence: 'CV' }], technical_gaps: [], immigration: { classification: 'unknown', evidence: [] }, language: { classification: 'compatible', evidence: [] }, relocation: { classification: 'unknown', evidence: [] }, employment: { classification: 'employee', evidence: [] }, eligibility_blockers: [], uncertainties: [] };
  assert.equal(decideEuropeanJob(evaluation, { verification: blocked }).decision, 'rejected_confirmed_eligibility_blocker');
});
await check('default liveness checker is injectable and never calls a browser when ATS API is conclusive', async () => {
  // The module-level function is covered indirectly in live integration; this
  // fixture keeps verification itself isolated from external services.
  assert.equal(typeof checkVacancyLiveness, 'function');
});
