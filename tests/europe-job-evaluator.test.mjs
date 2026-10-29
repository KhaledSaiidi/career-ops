// tests/europe-job-evaluator.test.mjs — deterministic European-job acceptance
// policy, persistent evaluation cache, and bounded OpenAI request retries.
//
// This intentionally uses the repository's pass/fail runner rather than
// node:test: discovered suites are imported by test-all.mjs, so tests remain
// runnable in the same offline sandbox as the rest of the project.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pass, fail } from './helpers.mjs';
import { decideEuropeanJob, evaluationCacheKey, readEvaluationCache, validateEuropeanEvaluation, writeEvaluationCache } from '../lib/europe-job-evaluator.mjs';
import { assertSafeOpenAiBaseUrl, requestStructuredJson } from '../lib/openai-client.mjs';

console.log('\neurope-job evaluator — policy, cache, and OpenAI retry contract');

function evaluation(score = 75, blockers = []) {
  let remaining = score;
  const point = (maximum) => {
    const value = Math.min(maximum, remaining);
    remaining -= value;
    return value;
  };
  return {
    schema_version: 1, match_score: score,
    score_breakdown: { technical_stack: point(30), responsibilities: point(20), seniority_experience: point(15), immigration_feasibility: point(15), language: point(10), relocation: point(5), employment_arrangement: point(5) },
    technical_matches: [{ requirement: 'Kubernetes', candidate_evidence: 'EKS and AKS experience in cv.md' }], technical_gaps: [],
    immigration: { classification: 'unknown', evidence: [] }, language: { classification: 'compatible', evidence: ['English C1'] }, relocation: { classification: 'unknown', evidence: [] }, employment: { classification: 'employee', evidence: [] }, eligibility_blockers: blockers, uncertainties: [],
  };
}

async function check(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (error) {
    fail(`${label} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check('score boundary is deterministic: 74 rejects and 75 accepts', () => {
  assert.equal(decideEuropeanJob(evaluation(74)).decision, 'rejected_below_threshold');
  assert.equal(decideEuropeanJob(evaluation(75)).accepted, true);
});

await check('a high score with a confirmed blocker always rejects', () => {
  const result = decideEuropeanJob(evaluation(95, [{ status: 'confirmed', code: 'no_sponsorship', evidence: 'No sponsorship available' }]));
  assert.equal(result.decision, 'rejected_confirmed_eligibility_blocker');
});

await check('invalid breakdown totals fail closed', () => {
  const value = evaluation(75);
  value.score_breakdown.responsibilities = 19;
  assert.equal(validateEuropeanEvaluation(value).valid, false);
  assert.equal(decideEuropeanJob(value).decision, 'rejected_invalid_evaluation');
});

await check('cache keys change with CV, JD, model, or profile and cache expires', () => {
  const base = { listingFingerprint: 'listing-1', jobDescription: 'JD', cvText: 'CV', profileText: 'Profile', model: 'gpt-test' };
  const key = evaluationCacheKey(base);
  assert.notEqual(key, evaluationCacheKey({ ...base, cvText: 'new CV' }));
  const root = mkdtempSync(join(tmpdir(), 'career-ops-europe-eval-'));
  const path = join(root, 'cache.json');
  writeEvaluationCache(path, key, evaluation(75), { now: 1_000 });
  assert.equal(readEvaluationCache(path, key, { now: 1_001 })?.evaluation.match_score, 75);
  assert.equal(readEvaluationCache(path, key, { now: 1_000 + 24 * 60 * 60 * 1000 }), null);
});

await check('OpenAI client retries transient 429 and sends JSON-schema output request', async () => {
  let calls = 0;
  const fetchFn = async (_url, options) => {
    calls++;
    if (calls === 1) return new Response('rate limited', { status: 429 });
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.type, 'json_schema');
    return new Response(JSON.stringify({ model: 'gpt-test', choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }), { status: 200 });
  };
  const result = await requestStructuredJson({ apiKey: 'test', model: 'gpt-test', messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' }, fetchFn, sleep: async () => {}, maxAttempts: 2 });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.attempts, 2);
});

await check('OpenAI client retries a schema-valid JSON response that fails the evaluator contract', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    const value = calls === 1 ? { schema_version: 1, match_score: 75 } : evaluation(75);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
  };
  const result = await requestStructuredJson({ apiKey: 'test', model: 'gpt-test', messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' }, validate: validateEuropeanEvaluation, fetchFn, sleep: async () => {}, maxAttempts: 2 });
  assert.equal(result.value.match_score, 75);
  assert.equal(result.attempts, 2);
});

await check('OpenAI client does not retry credential failures', async () => {
  let calls = 0;
  await assert.rejects(() => requestStructuredJson({ apiKey: 'test', model: 'gpt-test', messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' }, fetchFn: async () => { calls++; return new Response('no', { status: 401 }); }, sleep: async () => {}, maxAttempts: 3 }));
  assert.equal(calls, 1);
});

await check('OpenAI endpoint rejects remote cleartext and permits HTTPS or loopback development', () => {
  assert.equal(assertSafeOpenAiBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(assertSafeOpenAiBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.throws(() => assertSafeOpenAiBaseUrl('http://example.test/v1'));
});
