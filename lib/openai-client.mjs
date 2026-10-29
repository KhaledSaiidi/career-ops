import { randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
    || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

/** Reject endpoints that could send the CV or API key over cleartext. */
export function assertSafeOpenAiBaseUrl(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new TypeError('OPENAI_BASE_URL must be an absolute URL'); }
  if (parsed.username || parsed.password) throw new TypeError('OPENAI_BASE_URL must not contain credentials');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new TypeError('OPENAI_BASE_URL must use HTTPS unless it is a loopback development endpoint');
  }
  return parsed.toString().replace(/\/$/, '');
}

export class OpenAiRequestError extends Error {
  constructor(message, { status = null, retryable = false, cause = undefined } = {}) {
    super(message, { cause });
    this.name = 'OpenAiRequestError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function isRetryableOpenAiFailure(error) {
  if (error?.retryable === true) return true;
  const status = Number(error?.status);
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function retryDelayMs(attempt, { baseMs = 500, maxMs = 8_000 } = {}) {
  return Math.min(maxMs, baseMs * (2 ** attempt));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
  }
  return '';
}

/**
 * Calls Chat Completions with JSON Schema response_format. The caller owns
 * semantic validation; this module owns transport, retry and response parsing.
 */
export async function requestStructuredJson({
  apiKey,
  model,
  messages,
  schema,
  schemaName = 'europe_job_evaluation',
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 90_000,
  maxAttempts = 3,
  fetchFn = globalThis.fetch,
  sleep = defaultSleep,
  validate = null,
} = {}) {
  if (!apiKey) throw new OpenAiRequestError('OPENAI_API_KEY is required');
  if (!model) throw new OpenAiRequestError('OPENAI_MODEL is required');
  if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('messages must be a non-empty array');
  if (!schema || typeof schema !== 'object') throw new TypeError('schema must be an object');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn must be a function');
  if (validate !== null && typeof validate !== 'function') throw new TypeError('validate must be a function when provided');

  let lastError;
  const endpoint = `${assertSafeOpenAiBaseUrl(baseUrl)}/chat/completions`;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'x-client-request-id': randomUUID(),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: { name: schemaName, strict: true, schema },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const status = response.status;
        // Consume the body so the connection can be reused, but never echo
        // provider output: it may include request content or account details.
        await response.text();
        throw new OpenAiRequestError(`OpenAI request failed with HTTP ${status}`, {
          status,
          retryable: status === 408 || status === 409 || status === 429 || status >= 500,
        });
      }
      const payload = await response.json();
      const raw = textContent(payload?.choices?.[0]?.message?.content).trim();
      if (!raw) throw new OpenAiRequestError('OpenAI response did not contain JSON content');
      try {
        const value = JSON.parse(raw);
        const validation = validate?.(value);
        if (validation && validation.valid === false) {
          throw new OpenAiRequestError(`OpenAI response failed contract validation: ${(validation.errors ?? []).join('; ') || 'unknown validation error'}`, { retryable: true });
        }
        return { value, usage: payload?.usage ?? null, model: payload?.model ?? model, attempts: attempt + 1 };
      } catch (cause) {
        if (cause instanceof OpenAiRequestError) throw cause;
        throw new OpenAiRequestError('OpenAI response was not valid JSON', { cause });
      }
    } catch (error) {
      lastError = error instanceof OpenAiRequestError
        ? error
        : new OpenAiRequestError(error?.name === 'TimeoutError' ? 'OpenAI request timed out' : 'OpenAI request failed', {
          retryable: error?.name === 'TimeoutError' || error instanceof TypeError,
          cause: error,
        });
      if (attempt + 1 >= maxAttempts || !isRetryableOpenAiFailure(lastError)) throw lastError;
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError;
}
