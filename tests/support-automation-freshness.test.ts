import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks=vi.hoisted(()=>({createClient:vi.fn(),send:vi.fn()}));
vi.mock('@supabase/supabase-js',()=>({createClient:mocks.createClient}));
vi.mock('server-only',()=>({}));
vi.mock('../src/lib/server/support-email',()=>({deliverSupportReply:mocks.send}));
vi.mock('../src/lib/server/support-decision-email',()=>({deliverSupportDecisionRequest:vi.fn()}));
let POST:typeof import('../src/app/api/internal/support-automation/route').POST;
const id='2db3af4c-7fe2-4c65-a761-fd2d4639eb36';
const current='2026-09-16T12:00:01.000Z';
beforeAll(async()=>{
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://example.supabase.co');
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','test-key');
 vi.stubEnv('SUPPORT_AUTOMATION_SECRET','test-secret');
 ({POST}=await import('../src/app/api/internal/support-automation/route'));
});
beforeEach(()=>vi.clearAllMocks());
function request(expected_updated_at:string){return new NextRequest('https://example.com/api/internal/support-automation',{method:'POST',headers:{Authorization:'Bearer test-secret'},body:JSON.stringify({action:'claim',ticket_id:id,run_id:'freshness_test',expected_updated_at})});}
function client(updatedRow:Record<string,unknown>|null){
 const filters:Array<[string,unknown]>=[];
 const update=vi.fn();
 const chain={eq:(column:string,value:unknown)=>{filters.push([column,value]);return chain;},select:()=>chain,maybeSingle:async()=>({data:updatedRow,error:null})};
 update.mockReturnValue(chain);
 mocks.createClient.mockReturnValue({from:()=>({select:()=>({eq:()=>({single:async()=>({data:{id,status:'open',updated_at:current,message:'質問',category:'usage',subject:'操作の質問'},error:null})})}),update})});
 return {filters,update};
}
it('rejects a proposal based on an older ticket without modifying or sending',async()=>{
 const c=client(null);const r=await POST(request('2026-09-16T12:00:00.000Z'));
 expect(r.status).toBe(409);expect(c.update).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
});
it('uses updated_at even for open tickets and rejects concurrent inbound updates',async()=>{
 const c=client(null);const r=await POST(request(current));
 expect(c.filters).toContainEqual(['status','open']);expect(c.filters).toContainEqual(['updated_at',current]);expect(r.status).toBe(409);expect(mocks.send).not.toHaveBeenCalled();
});
it('claims the unchanged ticket',async()=>{
 const c=client({id,status:'in_progress',updated_at:current});const r=await POST(request(current));
 expect(r.status).toBe(200);expect((await r.json()).claimed).toBe(true);expect(c.filters).toContainEqual(['updated_at',current]);
});
