import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const EVALUATOR_SCHEMA_VERSION = 1;
export const EVALUATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const IMMIGRATION_CLASSIFICATIONS = new Set([
  'confirmed_vacancy_sponsorship', 'confirmed_employer_eligible', 'plausible', 'unknown', 'confirmed_blocker',
]);
export const LANGUAGE_CLASSIFICATIONS = new Set(['compatible', 'uncertain', 'confirmed_blocker']);
export const EMPLOYMENT_CLASSIFICATIONS = new Set(['employee', 'contractor', 'uncertain', 'confirmed_blocker']);

export const EUROPE_EVALUATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'match_score', 'score_breakdown', 'technical_matches', 'technical_gaps', 'immigration', 'language', 'relocation', 'employment', 'eligibility_blockers', 'uncertainties'],
  properties: {
    schema_version: { const: EVALUATOR_SCHEMA_VERSION },
    match_score: { type: 'integer', minimum: 0, maximum: 100 },
    score_breakdown: {
      type: 'object', additionalProperties: false,
      required: ['technical_stack', 'responsibilities', 'seniority_experience', 'immigration_feasibility', 'language', 'relocation', 'employment_arrangement'],
      properties: {
        technical_stack: { type: 'integer', minimum: 0, maximum: 30 },
        responsibilities: { type: 'integer', minimum: 0, maximum: 20 },
        seniority_experience: { type: 'integer', minimum: 0, maximum: 15 },
        immigration_feasibility: { type: 'integer', minimum: 0, maximum: 15 },
        language: { type: 'integer', minimum: 0, maximum: 10 },
        relocation: { type: 'integer', minimum: 0, maximum: 5 },
        employment_arrangement: { type: 'integer', minimum: 0, maximum: 5 },
      },
    },
    technical_matches: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['requirement', 'candidate_evidence'], properties: { requirement: { type: 'string', minLength: 1 }, candidate_evidence: { type: 'string', minLength: 1 } } } },
    technical_gaps: { type: 'array', items: { type: 'string' } },
    immigration: { type: 'object', additionalProperties: false, required: ['classification', 'evidence'], properties: { classification: { type: 'string', enum: [...IMMIGRATION_CLASSIFICATIONS] }, evidence: { type: 'array', items: { type: 'string' } } } },
    language: { type: 'object', additionalProperties: false, required: ['classification', 'evidence'], properties: { classification: { type: 'string', enum: [...LANGUAGE_CLASSIFICATIONS] }, evidence: { type: 'array', items: { type: 'string' } } } },
    relocation: { type: 'object', additionalProperties: false, required: ['classification', 'evidence'], properties: { classification: { type: 'string', enum: ['confirmed', 'plausible', 'unknown'] }, evidence: { type: 'array', items: { type: 'string' } } } },
    employment: { type: 'object', additionalProperties: false, required: ['classification', 'evidence'], properties: { classification: { type: 'string', enum: [...EMPLOYMENT_CLASSIFICATIONS] }, evidence: { type: 'array', items: { type: 'string' } } } },
    eligibility_blockers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['status', 'code', 'evidence'], properties: { status: { type: 'string', enum: ['confirmed', 'unknown'] }, code: { type: 'string', minLength: 1 }, evidence: { type: 'string', minLength: 1 } } } },
    uncertainties: { type: 'array', items: { type: 'string' } },
  },
};

const BREAKDOWN_LIMITS = { technical_stack: 30, responsibilities: 20, seniority_experience: 15, immigration_feasibility: 15, language: 10, relocation: 5, employment_arrangement: 5 };
const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

export function validateEuropeanEvaluation(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['evaluation must be an object'] };
  if (value.schema_version !== EVALUATOR_SCHEMA_VERSION) errors.push('unsupported schema_version');
  if (!Number.isInteger(value.match_score) || value.match_score < 0 || value.match_score > 100) errors.push('match_score must be an integer from 0 to 100');
  const breakdown = value.score_breakdown;
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) errors.push('score_breakdown must be an object');
  else {
    let total = 0;
    for (const [key, max] of Object.entries(BREAKDOWN_LIMITS)) {
      if (!Number.isInteger(breakdown[key]) || breakdown[key] < 0 || breakdown[key] > max) errors.push(`score_breakdown.${key} must be an integer from 0 to ${max}`);
      else total += breakdown[key];
    }
    if (total !== value.match_score) errors.push('match_score must equal score_breakdown total');
  }
  if (!Array.isArray(value.technical_matches) || !value.technical_matches.every((match) => match && hasText(match.requirement) && hasText(match.candidate_evidence))) errors.push('technical_matches must contain requirement and candidate_evidence');
  if (!stringArray(value.technical_gaps)) errors.push('technical_gaps must be a string array');
  if (!stringArray(value.uncertainties)) errors.push('uncertainties must be a string array');
  for (const [field, classifications] of [['immigration', IMMIGRATION_CLASSIFICATIONS], ['language', LANGUAGE_CLASSIFICATIONS], ['employment', EMPLOYMENT_CLASSIFICATIONS]]) {
    const entry = value[field];
    if (!entry || typeof entry !== 'object' || !classifications.has(entry.classification) || !stringArray(entry.evidence)) errors.push(`${field} is invalid`);
  }
  const relocation = value.relocation;
  if (!relocation || !['confirmed', 'plausible', 'unknown'].includes(relocation.classification) || !stringArray(relocation.evidence)) errors.push('relocation is invalid');
  if (!Array.isArray(value.eligibility_blockers) || !value.eligibility_blockers.every((blocker) => blocker && ['confirmed', 'unknown'].includes(blocker.status) && hasText(blocker.code) && hasText(blocker.evidence))) errors.push('eligibility_blockers is invalid');
  return { valid: errors.length === 0, errors };
}

export function decideEuropeanJob(evaluation, { threshold = 75 } = {}) {
  const checked = validateEuropeanEvaluation(evaluation);
  if (!checked.valid) return { accepted: false, decision: 'rejected_invalid_evaluation', reasons: checked.errors };
  const blockers = evaluation.eligibility_blockers.filter((blocker) => blocker.status === 'confirmed');
  if (evaluation.immigration.classification === 'confirmed_blocker' && blockers.length === 0) blockers.push({ code: 'immigration_confirmed_blocker', evidence: 'Evaluator classified immigration as a confirmed blocker' });
  if (evaluation.language.classification === 'confirmed_blocker' && !blockers.some((blocker) => blocker.code === 'language_confirmed_blocker')) blockers.push({ code: 'language_confirmed_blocker', evidence: 'Evaluator classified language as a confirmed blocker' });
  if (evaluation.employment.classification === 'confirmed_blocker' && !blockers.some((blocker) => blocker.code === 'employment_confirmed_blocker')) blockers.push({ code: 'employment_confirmed_blocker', evidence: 'Evaluator classified employment as a confirmed blocker' });
  if (blockers.length > 0) return { accepted: false, decision: 'rejected_confirmed_eligibility_blocker', reasons: blockers.map((blocker) => blocker.code), blockers };
  if (evaluation.match_score < threshold) return { accepted: false, decision: 'rejected_below_threshold', reasons: [`score_${evaluation.match_score}_below_${threshold}`] };
  return { accepted: true, decision: 'accepted_pending_verification', reasons: [] };
}

export function evaluationCacheKey({ listingFingerprint, jobDescription, cvText, profileText, model }) {
  if (!hasText(listingFingerprint) || !hasText(jobDescription) || !hasText(cvText) || !hasText(profileText) || !hasText(model)) throw new TypeError('cache key inputs must be non-empty strings');
  return createHash('sha256').update(JSON.stringify({ schema: EVALUATOR_SCHEMA_VERSION, listingFingerprint, jobDescription, cvText, profileText, model })).digest('hex');
}

export function readEvaluationCache(filePath, key, { now = Date.now(), ttlMs = EVALUATION_CACHE_TTL_MS } = {}) {
  if (!existsSync(filePath)) return null;
  let cache;
  try { cache = JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
  const entry = cache?.entries?.[key];
  if (!entry || !Number.isFinite(Date.parse(entry.cached_at)) || Date.parse(entry.cached_at) > now || now - Date.parse(entry.cached_at) >= ttlMs) return null;
  return validateEuropeanEvaluation(entry.evaluation).valid ? entry : null;
}

export function writeEvaluationCache(filePath, key, evaluation, { now = Date.now() } = {}) {
  if (!validateEuropeanEvaluation(evaluation).valid) throw new TypeError('refusing to cache invalid evaluation');
  let cache = { version: 1, entries: {} };
  if (existsSync(filePath)) {
    try { cache = JSON.parse(readFileSync(filePath, 'utf8')); } catch { /* corrupt cache is replaced, never interpreted */ }
  }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache) || !cache.entries || typeof cache.entries !== 'object') cache = { version: 1, entries: {} };
  cache.entries[key] = { cached_at: new Date(now).toISOString(), evaluation };
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  renameSync(temporary, filePath);
}

export function buildEuropeanEvaluationMessages({ job, cvText, profileText }) {
  if (!job || !hasText(job.description)) throw new TypeError('job.description is required');
  return [
    { role: 'system', content: 'Evaluate one European engineering vacancy against the candidate evidence. Return only JSON matching the supplied schema. Never invent candidate facts. Unknown sponsorship is not a blocker; explicit no-sponsorship, required existing work authorization without support, or a mandatory unsupported language is a confirmed blocker. Score dimensions must total exactly 100.' },
    { role: 'user', content: JSON.stringify({ candidate_cv: cvText, candidate_profile: profileText, job }) },
  ];
}
