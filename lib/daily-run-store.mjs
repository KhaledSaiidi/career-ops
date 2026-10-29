import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({ version: 2, processed: {}, identity_index: {}, pending_exports: {}, runs: {} });

function normalize(value) {
  if (!value || typeof value !== 'object' || !value.processed || !value.runs) return EMPTY();
  const processed = value.processed;
  const identity_index = value.identity_index && typeof value.identity_index === 'object' ? { ...value.identity_index } : {};
  // Version 1 did not retain every equivalent identity. Preserve its primary
  // keys so upgrades never cause a candidate to be evaluated again.
  for (const fingerprint of Object.keys(processed)) if (!identity_index[fingerprint]) identity_index[fingerprint] = fingerprint;
  const pending_exports = value.pending_exports && typeof value.pending_exports === 'object' ? value.pending_exports : {};
  return { version: 2, processed, identity_index, pending_exports, runs: value.runs };
}

export function readDailyRunStore(filePath) {
  if (!existsSync(filePath)) return EMPTY();
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    return normalize(value);
  } catch { return EMPTY(); }
}

export function writeDailyRunStore(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporary, filePath);
}

export function hasProcessed(state, identity) {
  const keys = typeof identity === 'string' ? [identity] : identity?.keys ?? [];
  return keys.some((key) => Boolean(state?.processed?.[state?.identity_index?.[key] ?? key]));
}

export function markProcessed(state, identity, record) {
  const primary = typeof identity === 'string' ? identity : identity?.primary;
  const keys = typeof identity === 'string' ? [identity] : identity?.keys ?? [];
  if (!primary) throw new TypeError('processed identity requires a primary key');
  state.version = 2;
  state.processed[primary] = { ...record, dedup_keys: [...new Set(keys)] };
  state.identity_index ??= {};
  for (const key of keys) state.identity_index[key] = primary;
  return state;
}
