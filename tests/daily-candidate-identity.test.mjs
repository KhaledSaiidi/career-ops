import assert from 'node:assert/strict';
import { pass, fail } from './helpers.mjs';
import { dailyCandidateIdentity } from '../lib/daily-candidate-identity.mjs';

console.log('\ndaily candidate identity — conservative durable dedup keys');
function check(label, fn) { try { fn(); pass(label); } catch (error) { fail(`${label} — ${error.message}`); } }
check('tracking URL variants share canonical URL identity', () => {
  const a = dailyCandidateIdentity({ url: 'https://jobs.example.test/a?jobId=7&utm_source=x' });
  const b = dailyCandidateIdentity({ url: 'https://jobs.example.test/a?utm_source=y&jobId=7' });
  assert.equal(a.primary, b.primary);
});
check('different known requisitions retain distinct identities despite identical title', () => {
  const a = dailyCandidateIdentity({ company: 'Example', title: 'Platform Engineer', location: 'Paris', requisition_id: 'REQ-1', url: 'https://jobs.example.test/1' });
  const b = dailyCandidateIdentity({ company: 'Example', title: 'Platform Engineer', location: 'Paris', requisition_id: 'REQ-2', url: 'https://jobs.example.test/2' });
  assert.notEqual(a.primary, b.primary);
  assert.notDeepEqual(a.keys, b.keys);
});
check('fallback identity is used only when no URL or requisition is available', () => {
  const identity = dailyCandidateIdentity({ company: 'Example', title: 'Platform Engineer', location: 'Paris' });
  assert.match(identity.primary, /^fallback:/);
});
