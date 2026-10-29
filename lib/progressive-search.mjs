import { createHash } from 'node:crypto';
import { hasProcessed, markProcessed } from './daily-run-store.mjs';

export const SEARCH_STAGE_NAMES = [
  'normal_discovery', 'expand_sources', 'expand_regions', 'expand_publication_window',
  'expand_related_roles', 'relax_career_preferences', 'expand_countries', 'unknown_sponsorship',
];

export function candidateFingerprint(candidate = {}) {
  const url = String(candidate.application_url ?? candidate.url ?? '').replace(/[?#].*$/, '').toLowerCase();
  return createHash('sha256').update(url || JSON.stringify([candidate.company, candidate.title, candidate.location])).digest('hex');
}

export function buildSearchStages(config) {
  const countries = Object.keys(config?.country_effort ?? {});
  const discovery = config?.discovery ?? {};
  return SEARCH_STAGE_NAMES.map((name, index) => ({
    number: index + 1,
    name,
    countries: index < 7 ? countries : undefined,
    posting_age_days: index < 3 ? discovery.initial_posting_age_days : index === 3 ? discovery.expanded_posting_age_days : discovery.maximum_posting_age_days,
    allow_unknown_sponsorship: index === 7,
  }));
}

/**
 * Run bounded staged discovery through injected adapters. The adapter owns the
 * actual Career-Ops scanner invocation; this controller owns target policy,
 * candidate reuse, no-progress diagnostics, and resumable processing state.
 */
export async function runProgressiveSearch({ config, discover, assess, state = { version: 1, processed: {}, runs: {} }, runId = new Date().toISOString(), maxCandidates = 250, maxStages = SEARCH_STAGE_NAMES.length } = {}) {
  if (typeof discover !== 'function' || typeof assess !== 'function') throw new TypeError('discover and assess functions are required');
  const target = config?.target ?? {};
  const minimum = Number(target.minimum_qualified_jobs ?? 5);
  const preferredMax = Number(target.preferred_qualified_jobs_max ?? 15);
  if (!Number.isInteger(minimum) || minimum < 1 || !Number.isInteger(preferredMax) || preferredMax < minimum) throw new TypeError('invalid target configuration');
  const accepted = [];
  const attempts = [];
  const rejected = [];
  const seen = new Set();
  let processedCount = 0;
  for (const stage of buildSearchStages(config).slice(0, maxStages)) {
    if (accepted.length >= preferredMax || processedCount >= maxCandidates) break;
    const result = await discover(stage) ?? {};
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    attempts.push({ stage: stage.name, number: stage.number, sources: result.sources ?? [], discovered: candidates.length, note: result.note ?? null });
    for (const candidate of candidates) {
      if (accepted.length >= preferredMax || processedCount >= maxCandidates) break;
      const fingerprint = candidateFingerprint(candidate);
      if (seen.has(fingerprint) || hasProcessed(state, fingerprint)) { rejected.push({ fingerprint, reason: 'already_processed' }); continue; }
      seen.add(fingerprint);
      processedCount++;
      const assessment = await assess(candidate, stage);
      const acceptedCandidate = assessment?.accepted === true && assessment?.application_ready === true;
      markProcessed(state, fingerprint, { run_id: runId, stage: stage.name, decision: assessment?.decision ?? (acceptedCandidate ? 'accepted' : 'rejected'), processed_at: new Date().toISOString() });
      if (acceptedCandidate) accepted.push({ ...candidate, fingerprint, stage: stage.name, assessment });
      else rejected.push({ fingerprint, reason: assessment?.decision ?? (assessment?.application_ready === false ? 'not_application_ready' : 'not_accepted') });
    }
    // The operational minimum is an effort target: do not stop merely because
    // one to four opportunities were found. Reaching five permits continued
    // breadth through the preferred target; only 10–15/limits stop the run.
  }
  const shortfall = Math.max(0, minimum - accepted.length);
  const stageBudgetReached = maxStages < SEARCH_STAGE_NAMES.length && attempts.length >= maxStages;
  const report = { run_id: runId, accepted, rejected, attempts, processed: processedCount, target: { minimum, preferred_max: preferredMax }, shortfall, exhausted: !stageBudgetReached && attempts.length >= SEARCH_STAGE_NAMES.length && accepted.length < minimum, stopped_by_budget: stageBudgetReached };
  state.runs[runId] = { completed_at: new Date().toISOString(), accepted: accepted.map((row) => row.fingerprint), shortfall, attempts };
  return { report, state };
}
