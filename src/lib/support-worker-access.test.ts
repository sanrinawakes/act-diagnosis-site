import { describe, expect, it } from 'vitest';
import { supportAccessScope, supportWorkerActionError } from './support-worker-access';
const secret='w'.repeat(64);
describe('limited worker credentials',()=>{
 it('keeps admin, worker and read-only credentials separate',()=>{
  expect(supportAccessScope('Bearer admin','admin',secret)).toBe('admin');
  expect(supportAccessScope(`Bearer ${secret}`,'admin',secret)).toBe('worker');
  for(const h of [null,'Bearer reader','Bearer '+secret+'x','Basic '+secret])expect(supportAccessScope(h,'admin',secret)).toBeNull();
  expect(supportAccessScope('Bearer short',undefined,'short')).toBeNull();
  expect(supportAccessScope(`Bearer ${secret}`,secret,secret)).toBeNull();
 });
 it.each(['decision','hold','delete','refund','sql','quality_ignore'])('rejects %s',action=>expect(supportWorkerActionError({action})).toBeTruthy());
 it.each(['claim','reply','quality_claim'])('requires freshness for %s',action=>expect(supportWorkerActionError({action})).toBeTruthy());
 it('permits only a bounded usage reply to a fresh ticket',()=>{
  const b={action:'reply',expected_updated_at:'2026-09-17T00:00:00Z',classification:'usage',resolution_kind:'usage_answer'};
  expect(supportWorkerActionError(b)).toBeNull();
  for(const extra of [{to:'other@example.com'},{classification:'billing'},{resolution_kind:'account_fix'},{expected_updated_at:'invalid'}])expect(supportWorkerActionError({...b,...extra})).toBeTruthy();
 });
 it('does not dismiss quality incidents without a verified repair',()=>{
  expect(supportWorkerActionError({action:'quality_resolve',resolution_kind:'false_positive'})).toBeTruthy();
  expect(supportWorkerActionError({action:'quality_resolve',resolution_kind:'technical_fix'})).toBeNull();
 });
});
