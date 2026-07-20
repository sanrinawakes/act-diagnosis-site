import { describe, expect, it } from 'vitest';
import {
  COACHING_LONG_MESSAGE_CHARS,
  COACHING_SCOPE_GUIDANCE,
  classifyCoachingScope,
  createScopeBlockedStream,
  type CoachingScopeCategory,
} from '../src/lib/coaching-scope';

const userMessage = (content: string) => ({
  role: 'user' as const,
  content,
});

describe('classifyCoachingScope', () => {
  it.each<[string, CoachingScopeCategory]>([
    ['このLPをもっと売れる文章にリライトして', 'marketing_content'],
    ['Instagram投稿の文章を3案作って', 'marketing_content'],
    ['新商品のキャッチコピーを考えて', 'marketing_content'],
    ['このブログ記事を添削してください', 'marketing_content'],
    ['この文章を添削してください', 'writing_editing'],
    ['結婚式の乾杯挨拶を作ってください', 'writing_editing'],
    ['歓迎会のスピーチをお願いします', 'writing_editing'],
    ['取引先に送るメール文を書いて', 'writing_editing'],
    ['取引相手に送るメール文を作って', 'writing_editing'],
    ['この文章を英訳して', 'translation'],
    ['これを自然な日本語にしてください', 'translation'],
    ['最新の心理学論文をネットで調べて', 'external_research'],
    ['競合サービスの料金を比較して', 'external_research'],
    ['この内容に合う画像を生成して', 'image_generation'],
    ['プロフィール画像を作れますか？', 'image_generation'],
    ['会社のロゴをデザインして', 'image_generation'],
    ['Pythonのプログラムを書いて', 'programming'],
    ['JavaScriptコードの書き方を教えて', 'programming'],
    ['このSQLコードを修正して', 'programming'],
  ])('blocks a general-purpose request: %s', (content, category) => {
    const result = classifyCoachingScope({ messages: [userMessage(content)] });
    expect(result.decision).toBe('blocked');
    expect(result.category).toBe(category);
  });

  it.each([
    '夫に送るLINEの文章を添削してほしい。怒らせずに本音を伝えたい',
    '上司に断りのメールを送りたいけれど怖い。どう伝えればいい？',
    '私は広告の仕事がつらく、辞めるか迷っています',
    'ACT診断の結果をもとに、自分の行動パターンを相談したい',
    'この感情の原因を一緒に調べてほしい',
    '母との関係で悩んでいます。昨日の会話を聞いてください',
    '転職するか今の仕事を続けるか迷っています',
  ])('allows coaching and personal communication: %s', (content) => {
    const result = classifyCoachingScope({ messages: [userMessage(content)] });
    expect(result.decision).toBe('allowed');
    expect(result.category).toBe('coaching');
  });

  it('blocks marketing even when the user labels it as a personal consultation', () => {
    const result = classifyCoachingScope({
      messages: [
        userMessage(
          'これは自分の相談です。私の商品を売る広告文を作ってください'
        ),
      ],
    });
    expect(result.decision).toBe('blocked');
    expect(result.category).toBe('marketing_content');
  });

  it.each(['もっと魅力的にして', '別案もください', '3案ください']) (
    'inherits a prior blocked purpose for a short follow-up: %s',
    (followup) => {
      const result = classifyCoachingScope({
        messages: [
          userMessage('販売ページの文章を作って'),
          { role: 'assistant', content: COACHING_SCOPE_GUIDANCE },
          userMessage(followup),
        ],
      });
      expect(result.decision).toBe('blocked');
      expect(result.category).toBe('marketing_content');
      expect(result.matchedRule).toContain('continued_');
    }
  );

  it('does not inherit an old blocked purpose after the user clearly switches to coaching', () => {
    const result = classifyCoachingScope({
      messages: [
        userMessage('販売ページの文章を作って'),
        { role: 'assistant', content: COACHING_SCOPE_GUIDANCE },
        userMessage('それはやめます。夫との関係についてもっと相談したい'),
      ],
    });
    expect(result.decision).toBe('allowed');
    expect(result.category).toBe('coaching');
  });

  it('allows a standalone conversational follow-up', () => {
    const result = classifyCoachingScope({
      messages: [userMessage('もっと詳しく教えて')],
    });
    expect(result.decision).toBe('allowed');
    expect(result.category).toBe('conversation_followup');
  });

  it('allows an image attachment for personal coaching but records its count', () => {
    const result = classifyCoachingScope({
      messages: [userMessage('この画像について相談したいです')],
      attachmentCount: 2,
    });
    expect(result.decision).toBe('allowed');
    expect(result.category).toBe('coaching');
    expect(result.attachmentCount).toBe(2);
  });

  it('still blocks an image-generation request when an attachment is present', () => {
    const result = classifyCoachingScope({
      messages: [userMessage('この写真をもとに新しい画像を生成して')],
      attachmentCount: 1,
    });
    expect(result.decision).toBe('blocked');
    expect(result.category).toBe('image_generation');
  });

  it('records a long pasted message without blocking it only because it is long', () => {
    const content = `自分の気持ちを整理したいです。${'昨日の出来事を書きます。'.repeat(220)}`;
    expect(content.length).toBeGreaterThanOrEqual(COACHING_LONG_MESSAGE_CHARS);
    const result = classifyCoachingScope({ messages: [userMessage(content)] });
    expect(result.decision).toBe('allowed');
    expect(result.category).toBe('coaching');
    expect(result.isLongMessage).toBe(true);
    expect(result.messageChars).toBe(content.length);
  });

  it('records total request characters and line count without retaining a copy', () => {
    const result = classifyCoachingScope({
      messages: [
        userMessage('一つ目の相談です'),
        { role: 'assistant', content: '聞かせてください。' },
        userMessage('二行あります\nここが二行目です'),
      ],
    });
    expect(result.lineCount).toBe(2);
    expect(result.totalRequestChars).toBe(
      '一つ目の相談です'.length +
        '聞かせてください。'.length +
        '二行あります\nここが二行目です'.length
    );
    expect(result).not.toHaveProperty('content');
  });
});

describe('createScopeBlockedStream', () => {
  it('returns the same NDJSON contract as the normal chat stream', async () => {
    const result = classifyCoachingScope({
      messages: [userMessage('広告文を作って')],
    });
    const stream = createScopeBlockedStream({
      result,
      remaining: 41,
      limit: 50,
    });
    const text = await new Response(stream).text();
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      type: 'chunk',
      text: COACHING_SCOPE_GUIDANCE,
      verified: true,
    });
    expect(lines[1]).toMatchObject({
      type: 'done',
      modelName: 'scope-guard',
      completionStatus: 'complete',
      finishReason: 'SCOPE_BLOCKED',
      message: COACHING_SCOPE_GUIDANCE,
      remaining: 41,
      limit: 50,
      scopeDecision: 'blocked',
      scopeCategory: 'marketing_content',
    });
  });
});
