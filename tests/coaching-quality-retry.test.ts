import { afterEach, describe, expect, it } from 'vitest';
import {
  assessCoachingResponseQuality,
  buildFinalVerifiedQualityFallback,
  buildUrgentSafetyResponse,
  ensureVerifiedCoachingResolution,
  verifyImmediateCoachingResponse,
  type CoachingChatMessage,
} from '../src/lib/coaching-gemini';
import {
  detectStoredCoachingQualityIncidents,
  persistResponseGateQualityIncidents,
} from '../src/lib/coaching-quality-incidents';
import type { SupabaseClient } from '@supabase/supabase-js';

// Synthetic service notices and conversations. No production conversation text.
const retryNotice =
  '申し訳ありません。今の内容を取り違えないように返答を整え直しています。推測で話を進めたり、すでに答えてくださったことを聞き直したりせず、直前までの内容を確認して続けます。お手数ですが、今のメッセージをそのままもう一度送ってください。';
const originalMode = process.env.COACHING_OUTPUT_PIPELINE_MODE;
afterEach(() => {
  if (originalMode === undefined) delete process.env.COACHING_OUTPUT_PIPELINE_MODE;
  else process.env.COACHING_OUTPUT_PIPELINE_MODE = originalMode;
});

describe('quality recovery service notices', () => {
  it.each([
    '新しい仕事の担当が決まりました。',
    '家計簿で来月の予算を見直します。',
    'SNSの投稿で扱う内容を決めました。',
    '家族との家事の分担について相談します。',
    '明日の朝、一つだけ具体策を教えてください。',
    '同じ質問ばかりで答えになっていません。',
  ])('固定の再送案内を相談領域の語句不足で拒否しない: %s', (lastUserText) => {
    expect(assessCoachingResponseQuality({ text: retryNotice, lastUserText }).issues)
      .toEqual([]);
  });

  it('案内に追記された不適切な助言まで信頼しない', () => {
    const result = assessCoachingResponseQuality({
      text: `${retryNotice}\n\n家事代行の費用を共通の生活費から支払うルールにしてください。`,
      lastUserText: '家族との生活費の分担に困っています。',
    });
    expect(result.issues).toContain('unsafe_high_impact_advice');
    expect(assessCoachingResponseQuality({
      text: `以下は過去の会話の保存済み要約です。\n${retryNotice}`,
      lastUserText: '仕事の相談です。',
    }).issues).toContain('internal_context_exposure');
  });

  it('再送案内が続くサービス障害の監査を無効にしない', () => {
    const messages = Array.from({ length: 3 }, (_, index) => [
      {
        id: `user-${index}`, session_id: 'synthetic-session', role: 'user' as const,
        content: '仕事の相談を続けます。',
        created_at: new Date(Date.UTC(2026, 0, 1, 0, index * 2)).toISOString(),
      },
      {
        id: `assistant-${index}`, session_id: 'synthetic-session', role: 'assistant' as const,
        content: retryNotice,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, index * 2 + 1)).toISOString(),
      },
    ]).flat();
    expect(detectStoredCoachingQualityIncidents({ messages })).toEqual(
      expect.arrayContaining([expect.objectContaining({
        assistantMessageId: 'assistant-2', issue: 'repeated_response_three_times',
      })])
    );
  });

  it.each(['minimal', 'legacy'])('全候補を使い切った後は同じ再送案内を繰り返さず復旧導線を示す: %s', (mode) => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = mode;
    const repeated =
      '仕事のことで迷っている時は、仕事全体の結論を急がず、実際に困った場面と次に確認する点を分けると、具体的な対応を選びやすくなります。最後に困った仕事の場面で、誰が何を言ったかを一つだけ教えてください。';
    const history: CoachingChatMessage[] = [
      { role: 'user', content: '今の仕事から別の職種に移りたいです。' },
      { role: 'assistant', content: repeated },
      { role: 'user', content: '研修の担当が変わりました。' },
      { role: 'assistant', content: repeated },
    ];
    const lastUserText = '来週からです。';
    const results = [];
    for (let turn = 0; turn < 10; turn++) {
      const result = ensureVerifiedCoachingResolution({
        resolution: {
          text: repeated, usage: { total_tokens: 12 }, modelName: 'synthetic-test',
          repairAttempted: false, repairAccepted: false,
          initialIssues: ['context_mismatch'], finalIssues: ['context_mismatch'],
        },
        lastUserText,
        historyMessages: history,
      });
      results.push(result);
      history.push({ role: 'user', content: lastUserText }, { role: 'assistant', content: result.text });
    }
    for (const result of results) {
      expect(result.finalIssues).toEqual([]);
      expect(result.chargeable).toBe(false);
      expect(result.usage).toEqual({});
      expect(result.text).not.toBe(repeated);
      expect(result.text).not.toMatch(/^「[^」]+」という相談ですね。$/);
    }
    const retryNotices = results.filter((result) => /もう一度|再送/.test(result.text));
    expect(retryNotices).toHaveLength(3);
    expect(results.some((result) => /新しいチャットを開いて/.test(result.text))).toBe(true);
  });

  it.each(['minimal', 'legacy', 'observe'])('一度目の再送案内から未完了の品質事故として記録する: %s', async (mode) => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = mode;
    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: retryNotice, usage: { total_tokens: 5 }, modelName: 'synthetic-test',
        repairAttempted: false, repairAccepted: false, initialIssues: [], finalIssues: [],
      },
      lastUserText: '仕事の相談です。', historyMessages: [],
    });
    expect(assessCoachingResponseQuality({ text: result.text, lastUserText: '仕事の相談です。' }).score)
      .toBe(0);
    expect(result.qualitySafetyHold).toBe(true);
    expect(result.chargeable).toBe(false);
    let rows: Array<{ issue: string }> = [];
    const supabaseAdmin = {
      from: () => ({ upsert: (input: typeof rows) => {
        rows = input;
        return { select: async () => ({ data: [{ id: 'synthetic-incident' }], error: null }) };
      } }),
    } as unknown as SupabaseClient;
    expect(await persistResponseGateQualityIncidents({
      supabaseAdmin, assistantMessageId: 'synthetic-assistant', sessionId: 'synthetic-session',
      userId: 'synthetic-user', qualitySafetyHold: result.qualitySafetyHold,
      qualityFinalIssues: result.finalIssues,
    })).toBe(1);
    expect(rows.map((row) => row.issue)).toContain('quality_safety_hold');
    const immediate = verifyImmediateCoachingResponse({
      text: retryNotice, modelName: 'synthetic-service-failure',
      lastUserText: '仕事の相談です。', historyMessages: [],
    });
    expect(immediate.qualitySafetyHold).toBe(true);
    expect(immediate.chargeable).toBe(false);
  });

  it('再送案内の履歴があっても緊急時の安全案内を優先する', () => {
    process.env.COACHING_OUTPUT_PIPELINE_MODE = 'minimal';
    const lastUserText = '仕事がつらく、今すぐ自分を傷つけそうです。';
    const result = ensureVerifiedCoachingResolution({
      resolution: {
        text: retryNotice, usage: {}, modelName: 'synthetic-test',
        repairAttempted: false, repairAccepted: false,
        initialIssues: ['context_mismatch'], finalIssues: ['context_mismatch'],
      },
      lastUserText,
      historyMessages: [{ role: 'assistant', content: retryNotice }],
    });
    expect(result.text).toBe(buildUrgentSafetyResponse(lastUserText));
    expect(result.chargeable).toBe(false);
  });
});

describe('learning budget recovery', () => {
  it('briefly naming money after a learning-cost concern returns a grounded answer', () => {
    const history: CoachingChatMessage[] = [
      {
        role: 'user',
        content: '学びに使う費用が続き、毎月のやりくりが苦しくなっています。',
      },
      {
        role: 'assistant',
        content: '実際に起きたことを一つだけ教えてください。',
      },
      {
        role: 'user',
        content: '前回の診断結果と違っていて理由が分かりません。',
      },
    ];
    const text = buildFinalVerifiedQualityFallback('金銭面です。', history);

    expect(text).toContain('学びにかけるお金');
    expect(text).toContain('収入と必ず出る支出');
    expect(text).not.toMatch(/もう一度送|整え直/);
    expect(
      assessCoachingResponseQuality({
        text,
        lastUserText: '金銭面です。',
        historyMessages: history,
      }).issues
    ).toEqual([]);
  });
});

describe('established cancellation conversation continuity', () => {
  const history: CoachingChatMessage[] = [
    { role: 'user', content: '仕事で予約の変更が続いています。' },
    { role: 'assistant', content: '直近では、どのようなことがありましたか？' },
    { role: 'user', content: 'お客様から予約をキャンセルしたいと連絡がありました。' },
    { role: 'assistant', content: '仕事の最後に困った場面で、誰が何を言ったか教えてください。' },
  ];
  it.each(['すみません。', '接客業です。', 'はい、接客', 'そうです。'])('短い補足 %s から同じ出来事を再質問しない', (lastUserText) => {
    const text = buildFinalVerifiedQualityFallback(lastUserText, history);
    expect(text).toContain('キャンセル');
    expect(text).not.toMatch(/誰が何を|いつ|どのような出来事|明日|5分|もう一度|再送/);
    expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: history }).issues)
      .toEqual([]);
  });
  it('直前の言葉の質問への案を、古い仕事完了の報告へ置き換えない', () => {
    const recent: CoachingChatMessage[] = [
      { role: 'user', content: '仕事で予定が変わって落ち着きません。' },
      { role: 'assistant', content: '今の予定を整理できます。' },
      { role: 'user', content: '今日は準備を終えました。' },
      { role: 'assistant', content: '直近で何かやり取りはありましたか？' },
      { role: 'user', content: 'キャンセルしてほしいと連絡がありました。' },
      { role: 'assistant', content: '相手に最初に返す言葉を変えるなら、何と伝えますか？' },
    ];
    const lastUserText = '次回もお待ちしています。';
    const text = buildFinalVerifiedQualityFallback(lastUserText, recent);
    expect(text).toContain('次回もお待ちしています');
    expect(text).not.toContain('今日は準備を終えました');
    expect(text).not.toContain('お客様');
    expect(text).toContain('キャンセル');
    expect(text).not.toMatch(/返金|料金|頑張|がんば/);
    expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: recent }).issues)
      .toEqual([]);
  });
  it.each(['ACTIを退会して課金を止めたいです。', '今はSNSの投稿について相談します。'])('別の手続きや話題 %s へ流用しない', (lastUserText) => {
    const text = buildFinalVerifiedQualityFallback(lastUserText, history);
    expect(text).not.toContain('キャンセルをご希望なのですね');
  });
  it.each([
    '話題を変えて、SNSの投稿を相談したいです。',
    'SNSの投稿について相談したいです。',
    '明日の会議が不安です。',
  ])('言葉を考える質問の直後でも新しい相談 %s を案として引用しない', (lastUserText) => {
    const recent: CoachingChatMessage[] = [
      ...history.slice(0, -1),
      { role: 'assistant', content: '相手に最初に返す言葉を変えるなら、何と伝えますか？' },
    ];
    const text = buildFinalVerifiedQualityFallback(lastUserText, recent);
    expect(text).not.toMatch(/最初に伝える言葉の案|キャンセルをご希望なのですね/);
  });
  it.each(['はい。', 'すみません。', '承知しました。'])('理由が既に伝えられている時の %s では同じ理由を聞き直さない', (lastUserText) => {
    const recent: CoachingChatMessage[] = [
      { role: 'user', content: '仕事で予約を担当しています。' },
      { role: 'assistant', content: '最近はどんなやり取りがありましたか？' },
      { role: 'user', content: '引越しのためキャンセルしたいと連絡を受けました。' },
      { role: 'assistant', content: '最初に返す言葉を変えるなら、どう伝えますか？' },
    ];
    const text = buildFinalVerifiedQualityFallback(lastUserText, recent);
    expect(text).toContain('既に伝えられている場合は聞き直さず');
    expect(text).not.toMatch(/理由はまだ分から|まだ理由が分から|理由を一つ確認|理由を確認|なぜ/);
    expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: recent }).issues)
      .toEqual([]);
  });
  it.each([
    'お客様から予約をキャンセルしたいと連絡がありました。',
    'お客様からキャンセルの希望がありました。理由はまだ聞いていません。',
    'お客様からキャンセルの希望がありました。理由は分かりません。',
    'お客様からキャンセルの希望がありました。都合はまだ確認していません。',
  ])('発信者や理由への言及だけで理由の既知・未知を断定しない: %s', (report) => {
    const recent: CoachingChatMessage[] = [
      { role: 'user', content: '仕事で予約の受付をしています。' },
      { role: 'assistant', content: '最近のやり取りを教えてください。' },
      { role: 'user', content: report },
      { role: 'assistant', content: '最初に返す言葉を考えるなら、どう伝えますか？' },
    ];
    const text = buildFinalVerifiedQualityFallback('はい。', recent);
    expect(text).not.toMatch(/理由も伝えている|希望と理由を聞いた|理由はまだ分から|まだ理由が分から/);
    expect(text).toContain('既に伝えられている場合');
  });
  it('理由が別の発言で伝えられていても未知と断定しない', () => {
    const recent: CoachingChatMessage[] = [
      { role: 'user', content: '仕事で予約の受付をしています。' },
      { role: 'assistant', content: '最近のやり取りを教えてください。' },
      { role: 'user', content: 'お客様からキャンセルの希望がありました。' },
      { role: 'assistant', content: '理由について何か聞いていますか？' },
      { role: 'user', content: '引っ越しが決まったそうです。' },
      { role: 'assistant', content: '最初に返す言葉を考えるなら、どう伝えますか？' },
    ];
    const text = buildFinalVerifiedQualityFallback('はい。', recent);
    expect(text).not.toMatch(/理由も伝えている|希望と理由を聞いた|理由はまだ分から|まだ理由が分から/);
    expect(text).toContain('既に伝えられている場合');
  });
  it('相手からの契約終了の申し出を、自分の会員退会と混同しない', () => {
    const recent: CoachingChatMessage[] = [
      { role: 'user', content: '仕事でお客様との応対を担当しています。' },
      { role: 'assistant', content: '最近のやり取りを一つ教えてください。' },
      { role: 'user', content: '解約を希望するという申し出を受けました。' },
      { role: 'assistant', content: '最初に返す言葉を考えるなら、どう伝えますか？' },
    ];
    const lastUserText = 'また機会があればお願いします。';
    const text = buildFinalVerifiedQualityFallback(lastUserText, recent);
    expect(text).toContain('また機会があればお願いします');
    expect(text).toContain('解約をご希望なのですね');
    expect(text).not.toMatch(/返金|手続き|解約を承|契約を終了|お客様/);
    expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: recent }).issues)
      .toEqual([]);
  });
  it('職場で実際に出た解約の話を、無関係な会員サービスと誤認しない', () => {
    const lastUserText = '仕事で、相手から解約したいと相談を受けました。';
    const text = '仕事で相手から解約の希望を聞いたのですね。解約の希望を受け取ったことと、その理由を確かめることは分けられます。理由がまだ分からない段階では、相手の事情を決めつける必要はありません。まずは希望を確認し、差し支えない範囲で理由を一つ尋ねてください。';
    expect(assessCoachingResponseQuality({ text, lastUserText }).issues)
      .not.toContain('context_mismatch');
  });
  it.each(['そうです。', '仕事で相手から解約したいと相談を受けました。'])('既出の解約から別の会員サービスや引落しを作らない: %s', (lastUserText) => {
    const recent: CoachingChatMessage[] = [
      { role: 'user', content: '仕事で相手の解約の希望を聞いています。' },
      { role: 'assistant', content: 'その希望を受け取る返答を考えられます。' },
    ];
    for (const text of [
      'AWAKESの解約のことですね。手続きの条件を確認してください。',
      '解約なら、次の引き落としを止める条件を確認してください。',
    ]) {
      expect(assessCoachingResponseQuality({ text, lastUserText, historyMessages: recent }).issues)
        .toContain('context_mismatch');
    }
  });
});
