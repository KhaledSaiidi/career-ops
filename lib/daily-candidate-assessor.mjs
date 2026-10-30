import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadYaml } from './yaml-document.mjs';
import { verifyVacancy } from './vacancy-verifier.mjs';
import { requestStructuredJson } from './openai-client.mjs';
import { EUROPE_EVALUATION_JSON_SCHEMA, buildEuropeanEvaluationMessages, decideEuropeanJob, validateEuropeanEvaluation } from './europe-job-evaluator.mjs';
import { buildCodexEvaluationPrompt, requestCodexStructuredEvaluation } from './codex-cli-evaluator.mjs';

/** Verify every candidate, then use the explicitly enabled configured evaluator. */
export async function assessDailyCandidate(candidate, { root, evaluate = false, indSnapshot = null, backend = 'codex-cli', verifyFn = verifyVacancy, requestFn = requestStructuredJson, codexRequestFn = requestCodexStructuredEvaluation } = {}) {
  const verification = await verifyFn(candidate, { indSnapshot });
  if (!verification.application_ready) return { accepted: false, application_ready: false, decision: verification.status === 'blocked' ? 'rejected_confirmed_eligibility_blocker' : `rejected_${verification.status}`, verification };
  if (!evaluate) return { accepted: false, application_ready: true, decision: 'evaluation_disabled', verification };
  const cvPath = join(root, 'cv.md');
  const profilePath = join(root, 'config', 'profile.yml');
  if (!existsSync(cvPath) || !existsSync(profilePath)) return { accepted: false, application_ready: true, decision: 'evaluation_prerequisite_missing', verification };
  const cvText = readFileSync(cvPath, 'utf8');
  const profileText = JSON.stringify(loadYaml(readFileSync(profilePath, 'utf8')) ?? {});
  const job = { ...candidate, description: verification.job_description };
  let request;
  if (backend === 'codex-cli') {
    request = await codexRequestFn({ root, prompt: buildCodexEvaluationPrompt({ job, cvText, profileText }), schema: EUROPE_EVALUATION_JSON_SCHEMA, model: process.env.CODEX_EVALUATOR_MODEL || null, timeoutMs: Number(process.env.CODEX_EVALUATOR_TIMEOUT_MS || 120_000) });
  } else if (backend === 'openai-api') {
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    request = await requestFn({ apiKey: process.env.OPENAI_API_KEY, model, baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 90_000), messages: buildEuropeanEvaluationMessages({ job, cvText, profileText }), schema: EUROPE_EVALUATION_JSON_SCHEMA, validate: validateEuropeanEvaluation });
  } else {
    throw new Error(`Unsupported evaluator backend: ${backend}`);
  }
  const checked = validateEuropeanEvaluation(request.value);
  if (!checked.valid) throw new Error(`Evaluator result failed contract: ${checked.errors.join('; ')}`);
  const decision = decideEuropeanJob(request.value, { verification });
  return { ...decision, application_ready: true, verification, evaluation: request.value, model: request.model, usage: request.usage, attempts: request.attempts };
}
