import { stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation } from '../src/lib/coaching-quotation-language.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as actionLanguage from '../src/lib/coaching-action-language.mjs';
vi.mock('@/lib/openai', () => ({ getGenAI: () => { throw new Error('NETWORK_DISABLED'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: () => { throw new Error('ALERT_DISABLED'); } }));
// Observed synthetic public delivery, not original provider text. No API runs.
const observed = {
  "label": "normal-2",
  "lastUserText": "上司に否定されたように感じて、次の一言が怖いです。",
  "status": 200,
  "inputMessages": 3,
  "payloadBytes": 607,
  "firstChunkMs": 5145,
  "doneMs": 5178,
  "totalMs": 5182,
  "hasDone": true,
  "completionStatus": "complete",
  "finalizationStatus": "complete",
  "finishReason": "STOP",
  "modelName": "local-quality-fallback",
  "provider": "local",
  "qualityRepairAttempted": true,
  "qualityRepairAccepted": true,
  "qualityInitialIssues": [
    "too_short"
  ],
  "qualityFinalIssues": [],
  "expectedModelName": "",
  "expectedFinishReason": "STOP",
  "requiredResponseFragments": [],
  "usage": {
    "prompt_tokens": 4969,
    "completion_tokens": 45,
    "thoughts_tokens": 496,
    "total_tokens": 5510
  },
  "outputChars": 132,
  "remaining": 1500,
  "repeatsPreviousAssistant": false,
  "currentUserTexts": [
    "仕事のことで少し落ち込んでいます。短く整理を手伝ってください。",
    "上司に否定されたように感じて、次の一言が怖いです。"
  ],
  "userGrounding": {
    "expectation": false,
    "intimidation": false,
    "tension": false,
    "mistake": false,
    "anticipatedReaction": false,
    "hardWork": false,
    "existenceRespect": false,
    "emotionalPain": false,
    "hardship": false,
    "pain": false,
    "sadness": false,
    "regret": false,
    "heartResidue": false,
    "malice": false,
    "depleted": false,
    "cherishedThoughts": false,
    "anxiety": false,
    "impatience": false,
    "loneliness": false,
    "responsibility": false,
    "motivationalForce": false,
    "selfRegard": false,
    "unfairness": false,
    "disrespect": false,
    "wounded": false,
    "bracing": false,
    "physicalFreeze": false,
    "prediction": false,
    "suffering": false,
    "heartFatigue": false,
    "weightMetaphor": false,
    "moodSinking": false,
    "emotionSwitching": false,
    "emphaticCause": false,
    "overwhelmed": false,
    "energy": false,
    "pride": false,
    "motivation": false,
    "seriousness": false,
    "perfection": false,
    "largeBlock": false,
    "gap": false,
    "proving": false
  },
  "message": "上司に否定されたように感じて、次の一言が怖いのですね。次に話す内容を考える時は、相手の反応をこちらで決めつけず、あなたがその会話で避けたいことをはっきりさせると、伝えたい内容や言葉を選ぶ手掛かりになります。\n\n次にその上司へ話す時、いちばん避けたいことは何ですか？"
};
const source = readFileSync(resolve(process.cwd(),'scripts/smoke-coaching-chat.mjs'),'utf8');
// This slice contains only assertions and pure text helpers, with no request,
// authentication, cleanup, process, file-system or network capability in the VM.
const assertions = source.slice(source.indexOf('function assertResults('),source.indexOf('async function cleanup('));
const assertResults = vm.runInNewContext(`${assertions}\nassertResults`, {
  ...actionLanguage, stripJapaneseQuotationContent, containsUnbalancedJapaneseQuotation, expectedTextModel:'', maxFirstChunkMs:10000, maxTotalMs:15000,
});
// The safety-only pipeline rejects any local fixed reply outright, so the body
// is judged below as the model's own delivery; the raw record is covered too.
const aiDelivered = { ...observed, modelName: 'gemini-3.5-flash', provider: null };
const request = 'では、明日まず何をすればいいか一つだけ教えてください。';
const concrete = '明日の朝、上司との会話で避けたいことを一つだけメモに書いてください。';
function check(message: string, latest = request) {
  const result = {...aiDelivered,message,lastUserText:latest,outputChars:message.length};
  return () => assertResults([result]);
}
describe('conversation restriction target remains distinct from a topic within a conversation', () => {
  it('accepts the exact observed 132-character neutral fear response as a model reply in the real smoke assertions', () => {
    expect(() => assertResults([aiDelivered])).not.toThrow();
  });
  it('rejects the raw retry-notice delivery itself under the safety-only pipeline', () => {
    expect(() => assertResults([observed])).toThrow(/local fixed reply instead of an AI response/);
  });
  it('accepts the same grammatical target in one concrete action in smoke', () => {
    expect(check(concrete)).not.toThrow();
  });
  it.each([
    '明日の朝、上司との会話を避けてください。',
    '明日の朝、話題を業務の確認だけに限定してください。',
    '明日の朝、会話の範囲を業務に限定してください。',
  ])('still rejects an unrequested restriction: %s', (message) => {
    expect(check(message)).toThrow(/unsupported conversation restriction/);
  });
  it('still detects a separate restriction in a mixed response', () => {
    expect(check('明日の朝、その会話で避けたいことを考えた上で、上司との会話を避けてください。')).toThrow(/unsupported conversation restriction/);
  });
  it('retains the existing user-permission condition', () => {
    expect(check('明日の朝、上司との会話を避けてください。','上司との会話を避けたいです。')).not.toThrow();
  });
});
