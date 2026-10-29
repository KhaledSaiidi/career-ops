import { createHash } from 'node:crypto';
import { normalizeUrl } from '../url-key.mjs';

function text(value) { return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' '); }
function folded(value) { return text(value).toLocaleLowerCase('en-US'); }

/**
 * Conservative daily-agent identity. Strong ATS/listing and requisition
 * identities take precedence; canonical URLs cover ordinary board receipts.
 * A title/location fallback exists only where no URL or requisition survives,
 * so two distinct known requisitions never collapse because their titles match.
 */
export function dailyCandidateIdentity(candidate = {}) {
  const url = normalizeUrl(candidate.application_url ?? candidate.url ?? '');
  const listingKey = text(candidate.listing_key);
  const requisition = text(candidate.requisition_id ?? candidate.requisitionId ?? candidate.job_id ?? candidate.jobId);
  const employer = folded(candidate.employer_legal_name ?? candidate.company);
  const title = folded(candidate.title);
  const location = folded(candidate.location);
  const keys = [];
  if (listingKey) keys.push(`listing:${listingKey}`);
  if (requisition && employer) keys.push(`requisition:${employer}:${requisition}`);
  if (url) keys.push(`url:${url}`);
  if (!keys.length && employer && title && location) keys.push(`fallback:${employer}:${title}:${location}`);
  const material = keys.length ? keys : [`unkeyed:${createHash('sha256').update(JSON.stringify([employer, title, location, text(candidate.source)])).digest('hex')}`];
  return { primary: material[0], keys: [...new Set(material)], canonical_url: url || null, requisition_id: requisition || null };
}
