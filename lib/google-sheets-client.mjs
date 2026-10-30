import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

function base64url(value) { return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url'); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function message(body, fallback) { return body?.error?.message ?? fallback; }

export function loadServiceAccountCredentials(path) {
  if (!path) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required for Google Sheets synchronization');
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`Could not read Google service-account credentials from ${path}`); }
  if (value?.type !== 'service_account' || !value.client_email || !value.private_key || !value.token_uri) throw new Error('Google credential file is not a valid service-account JSON document');
  return value;
}

export function createServiceAccountTokenProvider(credentials, { fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
  let cached = null;
  return async () => {
    if (cached && cached.expires_at > now() + 30_000) return cached.access_token;
    const issued = Math.floor(now() / 1000);
    const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({ iss: credentials.client_email, scope: SHEETS_SCOPE, aud: credentials.token_uri, iat: issued, exp: issued + 300 })}`;
    const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).end().sign(credentials.private_key, 'base64url')}`;
    const response = await fetchFn(credentials.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) throw new Error(`Google OAuth token request failed: ${message(body, response.status)}`);
    cached = { access_token: body.access_token, expires_at: now() + Number(body.expires_in ?? 300) * 1000 };
    return cached.access_token;
  };
}

export function createGoogleSheetsClient({ tokenProvider, fetchFn = globalThis.fetch, sleepFn = sleep } = {}) {
  if (typeof tokenProvider !== 'function') throw new TypeError('tokenProvider is required');
  async function request(path, { method = 'GET', body = null, retries = 2 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchFn(`${API}/${path}`, { method, headers: { Authorization: `Bearer ${await tokenProvider()}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const parsed = await response.json().catch(() => ({}));
        if (response.ok) return parsed;
        const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        const error = new Error(`Google Sheets API ${method} failed (${response.status}): ${message(parsed, response.status)}`);
        error.retryable = retryable;
        if (!retryable || attempt === retries) throw error;
        lastError = error;
      } catch (error) {
        if (error?.retryable === false || attempt === retries) throw error;
        lastError = error;
      }
      await sleepFn(250 * (2 ** attempt));
    }
    throw lastError ?? new Error('Google Sheets API request failed');
  }
  return {
    getSpreadsheetMetadata: (spreadsheetId) => request(`${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount)))`),
    getValues: (spreadsheetId, range) => request(`${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`),
    // Appends are deliberately not retried: a dropped response may still mean
    // Google committed the row. The export orchestrator does read-before-retry.
    appendValues: (spreadsheetId, range, values) => request(`${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: { values }, retries: 0 }),
    // Explicit range writes are used by the Recommended Jobs exporter because
    // values.append can extend the detected A:M table even when given B:M.
    updateValues: (spreadsheetId, range, values) => request(`${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: 'PUT', body: { values }, retries: 0 }),
    setRangeBackgroundWhite: (spreadsheetId, sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) => request(`${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: [{ repeatCell: {
          range: { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex },
          cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } } },
          fields: 'userEnteredFormat.backgroundColorStyle',
        } }],
      },
      retries: 0,
    }),
  };
}

export function createGoogleSheetsClientFromCredentials(path, options = {}) {
  const credentials = loadServiceAccountCredentials(path);
  return createGoogleSheetsClient({ ...options, tokenProvider: createServiceAccountTokenProvider(credentials, options) });
}
