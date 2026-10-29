import assert from 'node:assert/strict';
import { pass, fail } from './helpers.mjs';
import { extractJobPostingJsonLd, fetchTheHubJobDescription } from '../lib/provider-jd.mjs';
import { verifyVacancy } from '../lib/vacancy-verifier.mjs';

console.log('\nprovider JD extraction — The Hub JSON-LD and public-feed liveness');
async function check(label, fn) { try { await fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
const html = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Platform Engineer","description":"<p>Build <b>Kubernetes</b> platforms.</p>"}</script>';
await check('extracts public JobPosting JSON-LD without executing page content', () => {
  assert.deepEqual(extractJobPostingJsonLd(html), { text: 'Build Kubernetes platforms.', title: 'Platform Engineer' });
});
await check('restricts The Hub fetches to its HTTPS job-detail host and path', async () => {
  const result = await fetchTheHubJobDescription('https://thehub.io/jobs/abc', { fetchFn: async () => new Response(html, { status: 200 }) });
  assert.equal(result.text, 'Build Kubernetes platforms.');
  assert.equal(await fetchTheHubJobDescription('https://evil.example/jobs/abc'), null);
});
await check('current WTTJ public-feed record can supply liveness and JD evidence when page checks are uncertain', async () => {
  const result = await verifyVacancy({ application_url: 'https://www.welcometothejungle.com/en/companies/acme/jobs/platform_paris', source: 'wttj-api', country: 'France', description: 'Kubernetes and Terraform platform work.' }, { livenessChecker: async () => ({ result: 'uncertain', code: 'access_blocked', reason: '403' }), jdFetcher: async () => null });
  assert.equal(result.status, 'verified');
  assert.equal(result.liveness.code, 'public_discovery_feed_active');
});
