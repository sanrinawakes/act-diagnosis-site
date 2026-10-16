import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { stripAttachmentMarkdown } from '../src/lib/attachments';
import { stripJapaneseQuotationContent } from '../src/lib/coaching-quotation-language.mjs';
import { currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';

const transport = vi.hoisted(() => ({ provider: 0, alert: 0, fetch: 0 }));
vi.mock('@/lib/openai', () => ({ getGenAI: () => { transport.provider++; throw new Error('NETWORK_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-provider-candidates', () => ({ generateCoachingProviderCandidate: async () => { transport.provider++; throw new Error('NETWORK_FORBIDDEN'); } }));
vi.mock('@/lib/coaching-alerts', () => ({ sendCoachingAlert: async () => { transport.alert++; throw new Error('ALERT_FORBIDDEN'); } }));
import { assessCoachingResponseQuality, buildFinalVerifiedQualityFallback, type CoachingChatMessage } from '../src/lib/coaching-gemini';

// Statically isolate the actual private helper and its actual two context
// functions. No provider, route, DB, credential, or production transport runs.
const source = readFileSync(resolve(process.cwd(), 'src/lib/coaching-gemini.ts'), 'utf8');
const ast = ts.createSourceFile('coaching-gemini.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['getCurrentPlanningUserTexts', 'reportsResponseDissatisfaction', 'buildFamilyLegalDraftRevisionFallback'];
const functions = names.map(name => {
  const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!found) throw new Error(`Missing actual helper: ${name}`);
  return found.getText(ast);
}).join('\n');
const actualHelper = vm.runInNewContext(ts.transpileModule(`${functions}\nbuildFamilyLegalDraftRevisionFallback;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText, { currentTopicUserTexts, stripAttachmentMarkdown, stripJapaneseQuotationContent }) as
  (lastUserText: string, historyMessages: CoachingChatMessage[]) => string;
const records: unknown[] = [];
function helper(latest: string, history: CoachingChatMessage[]) {
  const output = actualHelper(latest, history);
  records.push({ kind: 'actual-private-guard', history, latest, output, emptyMeansFallthrough: output === '' });
  return output;
}
const U = (content: string): CoachingChatMessage => ({ role: 'user', content });
const A = (content: string): CoachingChatMessage => ({ role: 'assistant', content });
afterEach(() => { expect(transport).toEqual({ provider: 0, alert: 0, fetch: 0 }); vi.unstubAllGlobals(); });
afterAll(() => {
  const output = process.env.ACTI_LEGAL_REPLAY_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ transport, records }, null, 2), { flag: 'wx', mode: 0o600 });
});

// These three histories and latest inputs are byte-identical to existing
// coaching-output.test.ts legal tests. Old assistant wording is preserved.
const existing = [
  {
    id: 'custody-existing',
    history: [
      U('あくまで私は対立姿勢ではないこと、バッドカルマを生みたくないこと。調和をもとに話し合いをしたいことが前提である。そのうえで、私の主張は以下の通り。'),
      A('主張書面（回答）\n\n２．親権譲渡の前提条件について\n相手方は最低月１回の面会交流や年金手帳の返還に応じる姿勢を示されていますが、これらは親権を譲るか否かに関わらず当然に行われるべき事柄です。'),
    ],
    latest: 'これについては、今もそうだから現状と何ら変わらないということを言いたい。現状と変わらないのに親権を譲ることはできないということが言いたいの。',
    expected: /現状と何ら変わりません。[\s\S]*親権の譲渡に同意することはできません/,
    forbidden: /当然に行われるべき|年金手帳|最低月|譲る理由はなく/,
  },
  {
    id: 'dinner-existing',
    history: [
      U('平日夕食交流についての文がないからそれも作成してほしい。前回も伝えているが必ず週１回食事をさせろということではない。私にはその権利があると言うこと。したがって私が食事の要求をしたときに妨害をしてこないでほしいということを言いたい。'),
      A('平日交流の重要性について、子どもの精神的なケアの観点から以下の文章を作成しました。'),
    ],
    latest: '作成されてないよ？', expected: /夕食交流[\s\S]*妨げないでほしい/,
    forbidden: /権利がある|曜日や運用方法|子どもの精神的/,
  },
  {
    id: 'outside-meal-existing',
    history: [A('相手方出張時の監護についても、私は子どもを連れ出すのではなく、子どもが住み慣れた自宅で過ごせるよう、私が赴いて食事の用意や監護を行うと提案しています。')],
    latest: 'これに対しては私はこんな提案はしていない。相手方は私が家に入ることを拒絶しているし、それは私も受け入れている。だから外食だったりを提案している。',
    expected: /相手方宅に立ち入らないことは、私も受け入れています。[\s\S]*外食という形を提案しています/,
    forbidden: /相手方出張時|子ども|監護|見守り|支援|機会を認め/,
  },
];
describe('legal drafting only restates the explicitly stated user position', () => {
  it.each(existing)('$id public fallback', f => {
    vi.stubGlobal('fetch', async () => { transport.fetch++; throw new Error('NETWORK_FORBIDDEN'); });
    for (const output of [buildFinalVerifiedQualityFallback(f.latest, f.history)]) {
      const quality = assessCoachingResponseQuality({ text: output, lastUserText: f.latest, historyMessages: f.history });
      records.push({ kind: 'public-fallback', id: f.id, history: f.history, latest: f.latest, output, quality });
      expect(output).toMatch(f.expected); expect(output).not.toMatch(f.forbidden);
      expect(quality.issues).toEqual([]);
    }
  });
  it('does not extend the concise draft allowance to additional text', () => {
    const f = existing[1];
    const text = buildFinalVerifiedQualityFallback(f.latest, f.history) + '追記です。';
    expect(assessCoachingResponseQuality({ text, lastUserText: f.latest, historyMessages: f.history }).issues).toContain('too_short');
  });
  it('does not grant the concise draft allowance without the user position', () => {
    const f = existing[1];
    const text = buildFinalVerifiedQualityFallback(f.latest, f.history);
    expect(assessCoachingResponseQuality({ text, lastUserText: f.latest, historyMessages: [] }).issues).toContain('too_short');
  });
  it.each([
    '親権について文面を修正してください。',
    '平日と土日の面会について追記したいです。',
    '夕食交流の文章を書いてほしいです。',
    '学校行事や習い事への参加について修正してください。',
    '相手方出張時や外食の文章を書いてほしいです。',
    '交友関係や心配無用という言葉について追記したいです。',
  ])('does not turn keywords into a position or a history: %s', latest => {
    expect(helper(latest, [])).toBe('');
  });
  it.each([
    '平日の面会について話しています。私は土日にも月1回面会したいとは思っていません。この文面を修正してください。',
    '私は学校行事への参加を希望していますか？この文面を修正してください。',
    '相手方は私が家に入ることを拒絶しているが、それは私も受け入れているわけではない。外食を提案しているわけではないので修正してください。',
    '子どもが私に交友関係について相談したいと話していますか？この文面を修正してください。',
  ])('does not promote a negated or questioned position by prefix matching: %s', latest => {
    expect(helper(latest, [])).toBe('');
  });
  it('does not promote an assistant-only legal narrative to user facts', () => {
    expect(helper('作成されてないよ？', [A('平日の面会は自由でした。土日に月1回の面会を求めて拒否され、調停委員の関与で実現しました。親権の譲渡には同意できません。')])).toBe('');
  });
  it('does not reuse an old legal request after an explicit new topic', () => {
    expect(helper('話題を変えて、SNSの投稿について相談したいです。', existing[1].history)).toBe('');
  });
  it('does not use a third-party quotation as the user custody position', () => {
    expect(helper('相手方は「現状と変わらないのに親権を譲ることはできない」と言っています。文面を修正してください。', [])).toBe('');
  });
  it('keeps an explicit revocation and a denied report from restoring an old position', () => {
    expect(helper('先ほどの主張は撤回します。', [...existing[0].history, U(existing[0].latest)])).toBe('');
    expect(helper('現状と変わらないのに親権を譲ることはできない、とは言っていません。文面を修正してください。', [])).toBe('');
  });
  it.each(['先ほどの希望は、やはり希望しません。', 'それを求めているとは言っていません。'])('does not restore an older position after a short revocation: %s', latest => {
    expect(helper(latest, [...existing[0].history, U(existing[0].latest)])).toBe('');
  });
  it('does not turn a hypothetical first-person request into a real position', () => {
    expect(helper('仮に平日が難しくて、私は土日にも月1回面会したいと考えています。この希望を追記したいです。', [])).toBe('');
  });
  // These local rich-premise controls are not provider scenarios or customer
  // incidents. Every emitted fact is explicitly supplied in the input.
  it.each([
    ['平日の面会について話しています。私は土日にも月1回面会したいと考えています。この希望を追記したいです。', '土日に月1回の面会を希望しています。'],
    ['私は学校行事や習い事への参加を希望しています。この希望を文面に書いてほしいです。', '学校行事や習い事への参加を希望しています。'],
    ['子どもが私に交友関係について相談したいと話しています。この発言を文面に追記したいです。', '子どもは、私に交友関係について相談したいと話しています。'],
  ])('keeps an explicitly supplied narrow position: %s', (latest, expected) => {
    const result = helper(latest, []);
    expect(result).toContain(expected);
    expect(result).not.toMatch(/家を出た当初|拒否され|調停委員|制限することが優先|対立的|両親が参加|父親には話しにくい|心配無用|負担になり/);
  });
});
