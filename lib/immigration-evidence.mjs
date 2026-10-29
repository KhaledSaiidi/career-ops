import { createHash } from 'node:crypto';

export const IMMIGRATION_CLASSIFICATIONS = new Set([
  'confirmed_vacancy_sponsorship', 'confirmed_employer_eligible', 'plausible', 'unknown', 'confirmed_blocker',
]);

const OFFICIAL_ROUTES = {
  Netherlands: 'https://ind.nl/en/residence-permits/work/highly-skilled-migrant',
  France: 'https://www.service-public.fr/particuliers/vosdroits/F2728?lang=en',
  Belgium: 'https://www.belgium.be/en/work/coming_to_work_in_belgium',
  Denmark: 'https://www.nyidanmark.dk/en-GB/You-want-to-apply/Work',
  Luxembourg: 'https://guichet.public.lu/en/citoyens/immigration/vivre/non-luxembourg/immigration/pays-tiers/salarie/salarie-pays-tiers.html',
  Sweden: 'https://www.migrationsverket.se/en/employers/how-it-works.html',
};

export function normalizeLegalEntityName(value = '') {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\b(the|holding|holdings)\b/g, ' ')
    .replace(/\b(b\.?v\.?|n\.?v\.?|ltd\.?|limited|inc\.?|gmbh|s\.?a\.?r\.?l\.?|s\.?a\.?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function indSnapshotStatus(snapshot, { now = new Date(), maxAgeDays = 45 } = {}) {
  if (!snapshot || !Array.isArray(snapshot.employers)) return { usable: false, reason: 'IND sponsor snapshot is missing or malformed' };
  const asOf = Date.parse(snapshot.as_of);
  if (!Number.isFinite(asOf)) return { usable: false, reason: 'IND sponsor snapshot has no valid as_of date' };
  const ageDays = (new Date(now).getTime() - asOf) / 86_400_000;
  if (ageDays > maxAgeDays) return { usable: false, reason: `IND sponsor snapshot is stale (${Math.floor(ageDays)} days old)` };
  return { usable: true, as_of: new Date(asOf).toISOString().slice(0, 10), source_url: snapshot.source_url ?? 'https://ind.nl/en/public-register-recognised-sponsors/public-register-work' };
}

export function matchIndRecognizedSponsor(employerLegalName, snapshot, options = {}) {
  const status = indSnapshotStatus(snapshot, options);
  if (!status.usable) return { status: 'unavailable', ...status, matches: [] };
  const target = normalizeLegalEntityName(employerLegalName);
  if (!target) return { status: 'unavailable', reason: 'Employer legal name is required for IND matching', matches: [] };
  const matches = snapshot.employers.filter((entry) => normalizeLegalEntityName(typeof entry === 'string' ? entry : entry.name) === target);
  if (matches.length === 1) return { status: 'exact_match', ...status, match: matches[0], matches };
  if (matches.length > 1) return { status: 'ambiguous_match', ...status, matches };
  return { status: 'no_match', ...status, matches: [] };
}

const blockerPatterns = [
  ['no_visa_sponsorship', /(?:no|not|cannot|unable to)\s+(?:offer|provide|support)\s+(?:visa\s+)?sponsorship/i],
  ['no_visa_sponsorship', /no\s+(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|provided|offered)/i],
  ['no_work_permit_support', /(?:no|not|cannot|unable to)\s+(?:offer|provide|support)\s+(?:a\s+)?work permit/i],
  ['existing_work_authorization_required', /must\s+(?:already\s+)?(?:have|hold)\s+(?:the\s+)?(?:right|authorization|permission)\s+to\s+work/i],
];
const sponsorPatterns = [
  /(?:visa\s+)?sponsorship\s+(?:is|will be)\s+(?:available|provided|offered)/i,
  /we\s+(?:will\s+)?(?:sponsor|support)\s+(?:your\s+)?(?:visa|work permit)/i,
];
const relocationPattern = /(?:relocation (?:assistance|support|package)|relocate to)/i;

function snippet(text, index, length) {
  return text.slice(Math.max(0, index - 100), Math.min(text.length, index + length + 100)).replace(/\s+/g, ' ').trim();
}

export function findEligibilitySignals(jobDescription = '', sourceUrl = null) {
  const text = String(jobDescription);
  const blockers = [];
  for (const [code, pattern] of blockerPatterns) {
    const match = pattern.exec(text);
    if (match) blockers.push({ status: 'confirmed', code, evidence: snippet(text, match.index, match[0].length), evidence_url: sourceUrl });
  }
  const sponsorship = sponsorPatterns.map((pattern) => pattern.exec(text)).find(Boolean);
  const relocation = relocationPattern.exec(text);
  return { blockers, sponsorship: sponsorship ? snippet(text, sponsorship.index, sponsorship[0].length) : null, relocation: relocation ? snippet(text, relocation.index, relocation[0].length) : null };
}

export function assessImmigrationEvidence({ country, employerLegalName, jobDescription, jobUrl, indSnapshot, now = new Date() } = {}) {
  const signals = findEligibilitySignals(jobDescription, jobUrl);
  const routeUrl = OFFICIAL_ROUTES[country] ?? null;
  const evidence = routeUrl ? [{ type: 'official_country_route', url: routeUrl, note: 'Route information is context only and is not visa approval or vacancy sponsorship.' }] : [];
  if (signals.blockers.length) return { classification: 'confirmed_blocker', evidence, blockers: signals.blockers, sponsorship: 'not_supported', relocation_evidence: signals.relocation };
  if (signals.sponsorship) return { classification: 'confirmed_vacancy_sponsorship', evidence: [...evidence, { type: 'job_description', url: jobUrl ?? null, quote: signals.sponsorship }], blockers: [], sponsorship: 'confirmed_vacancy', relocation_evidence: signals.relocation };
  if (country === 'Netherlands') {
    const ind = matchIndRecognizedSponsor(employerLegalName, indSnapshot, { now });
    if (ind.status === 'exact_match') return { classification: 'confirmed_employer_eligible', evidence: [...evidence, { type: 'ind_recognised_sponsor_register', url: ind.source_url, as_of: ind.as_of, legal_entity: ind.match.name ?? ind.match }], blockers: [], sponsorship: 'unconfirmed', ind, relocation_evidence: signals.relocation };
    evidence.push({ type: 'ind_recognised_sponsor_register', url: ind.source_url ?? 'https://ind.nl/en/public-register-recognised-sponsors/public-register-work', status: ind.status, note: ind.reason ?? 'No exact legal-entity match. This is not evidence that sponsorship is impossible.' });
  }
  if (signals.relocation && routeUrl) return { classification: 'plausible', evidence: [...evidence, { type: 'job_description', url: jobUrl ?? null, quote: signals.relocation }], blockers: [], sponsorship: 'unconfirmed', relocation_evidence: signals.relocation };
  return { classification: 'unknown', evidence, blockers: [], sponsorship: 'unknown', relocation_evidence: null };
}

export function indSnapshotFingerprint(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot ?? null)).digest('hex');
}
