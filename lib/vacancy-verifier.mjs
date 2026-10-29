import { checkLivenessViaApi } from '../liveness-api.mjs';
import { fetchJdViaKnownApi } from '../browser-extract.mjs';
import { assessImmigrationEvidence } from './immigration-evidence.mjs';
import { fetchProviderJobDescription } from './provider-jd.mjs';

function validHttpUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}

export function normalizePostingDate(value) {
  if (!value) return { value: null, status: 'unknown' };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { value: null, status: 'unknown' };
  return { value: parsed.toISOString().slice(0, 10), status: 'verified' };
}

/** Mirrors check-liveness.mjs: public ATS API first, Playwright only on a miss. */
export async function checkVacancyLiveness(url) {
  const api = await checkLivenessViaApi(url, { boardCache: new Map() });
  if (api) return api;
  let browser;
  try {
    const { chromium } = await import('playwright');
    const { newLivenessPage, checkUrlLivenessWithFallback } = await import('../liveness-browser.mjs');
    browser = await chromium.launch({ headless: true });
    const page = await newLivenessPage(browser);
    return await checkUrlLivenessWithFallback(page, url);
  } catch (error) {
    return { result: 'uncertain', code: 'browser_unavailable', reason: `No API liveness result and browser fallback unavailable: ${String(error?.message ?? error).split('\n')[0]}` };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Verify facts for one candidate. Network dependencies are injectable for offline tests. */
export async function verifyVacancy(candidate, {
  livenessChecker = checkVacancyLiveness,
  jdFetcher = fetchJdViaKnownApi,
  providerJdFetcher = fetchProviderJobDescription,
  indSnapshot = null,
  now = new Date(),
} = {}) {
  const applicationUrl = candidate?.application_url ?? candidate?.url ?? null;
  if (!validHttpUrl(applicationUrl)) return { status: 'unverifiable', application_ready: false, reason: 'A complete official application URL is required', liveness: null, posting_date: normalizePostingDate(candidate?.posting_date), immigration: null, job_description: null };
  const checkedLiveness = await livenessChecker(applicationUrl) ?? { result: 'uncertain', code: 'liveness_unavailable', reason: 'No conclusive supported liveness result' };
  // These public feeds produced the candidate in the current scan. They are
  // evidence of a listing being active, not evidence that a submission worked.
  const sourceBacked = ['wttj-api', 'thehub-api'].includes(candidate?.source);
  const liveness = checkedLiveness.result === 'uncertain' && sourceBacked
    ? { result: 'active', code: 'public_discovery_feed_active', reason: `Current public ${candidate.source} discovery feed contained this listing` }
    : checkedLiveness;
  let fetched = liveness.result === 'active' ? await jdFetcher(applicationUrl).catch(() => null) : null;
  if (!fetched && liveness.result === 'active') fetched = await providerJdFetcher(candidate).catch(() => null);
  const jobDescription = fetched?.text ?? candidate?.description ?? null;
  const immigration = assessImmigrationEvidence({ country: candidate?.country, employerLegalName: candidate?.employer_legal_name ?? candidate?.company, jobDescription, jobUrl: applicationUrl, indSnapshot, now });
  const postingDate = normalizePostingDate(candidate?.posting_date);
  const active = liveness.result === 'active';
  const descriptionAvailable = typeof jobDescription === 'string' && jobDescription.trim().length > 0;
  const blocker = immigration.blockers.length > 0;
  const status = !active ? (liveness.result === 'expired' ? 'closed' : 'unverifiable') : !descriptionAvailable ? 'unverifiable' : blocker ? 'blocked' : 'verified';
  return {
    status,
    application_ready: status === 'verified',
    application_url: applicationUrl,
    liveness,
    posting_date: postingDate,
    job_description: jobDescription,
    jd_source: fetched ? 'known_ats_api' : (descriptionAvailable ? 'discovery_payload' : null),
    immigration,
  };
}
