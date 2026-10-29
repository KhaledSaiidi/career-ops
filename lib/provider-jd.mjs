function stripHtml(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function findJobPosting(value) {
  if (Array.isArray(value)) return value.map(findJobPosting).find(Boolean) ?? null;
  if (!value || typeof value !== 'object') return null;
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.includes('JobPosting') && typeof value.description === 'string') return value;
  return findJobPosting(value['@graph']);
}

/** Extract a description from a public JobPosting JSON-LD block. */
export function extractJobPostingJsonLd(html) {
  const scripts = String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const posting = findJobPosting(JSON.parse(match[1]));
      const text = stripHtml(posting?.description);
      if (text) return { text, title: typeof posting.title === 'string' ? posting.title : null };
    } catch { /* malformed JSON-LD is not evidence */ }
  }
  return null;
}

export async function fetchTheHubJobDescription(url, { fetchFn = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'thehub.io' || !/^\/jobs\/[^/]+$/.test(parsed.pathname)) return null;
  try {
    const response = await fetchFn(parsed.toString(), { headers: { accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return extractJobPostingJsonLd(await response.text());
  } catch { return null; }
}

export async function fetchProviderJobDescription(candidate, options = {}) {
  if (candidate?.source === 'thehub-api') return fetchTheHubJobDescription(candidate.application_url ?? candidate.url, options);
  return null;
}
