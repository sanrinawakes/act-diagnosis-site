import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks=vi.hoisted(()=>({client:vi.fn()}));
vi.mock('@supabase/supabase-js',()=>({createClient:mocks.client}));
vi.mock('server-only',()=>({}));
vi.mock('../src/lib/server/support-email',()=>({deliverSupportReply:vi.fn()}));
vi.mock('../src/lib/server/support-decision-email',()=>({deliverSupportDecisionRequest:vi.fn()}));
let POST:typeof import('../src/app/api/internal/support-automation/route').POST;
beforeAll(async()=>{
 vi.stubEnv('SUPPORT_AUTOMATION_SECRET','admin-secret');
 vi.stubEnv('SUPPORT_WORKER_SECRET','w'.repeat(64));
 ({POST}=await import('../src/app/api/internal/support-automation/route'));
});
beforeEach(()=>vi.clearAllMocks());
it.each([{action:'decision'},{action:'hold'},{action:'reply',classification:'billing'},{action:'claim'},{action:'quality_resolve',resolution_kind:'false_positive'}])('rejects scoped operation before database access: %j',async body=>{
 const r=await POST(new NextRequest('https://example.com/api/internal/support-automation',{method:'POST',headers:{Authorization:'Bearer '+'w'.repeat(64)},body:JSON.stringify(body)}));
 expect(r.status).toBe(403);expect(mocks.client).not.toHaveBeenCalled();
});
it('rejects the read-only report key before database access',async()=>{
 const r=await POST(new NextRequest('https://example.com/api/internal/support-automation',{method:'POST',headers:{Authorization:'Bearer report-only-secret'},body:JSON.stringify({action:'claim'})}));
 expect(r.status).toBe(401);expect(mocks.client).not.toHaveBeenCalled();
});
