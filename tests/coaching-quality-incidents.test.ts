import { describe, expect, it } from 'vitest';
import { COACHING_SCOPE_GUIDANCE } from '../src/lib/coaching-scope';
import {
  auditRecentStoredCoachingResponses,
  detectStoredCoachingQualityIncidents,
} from '../src/lib/coaching-quality-incidents';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('detectStoredCoachingQualityIncidents', () => {
  it('内部要約が混ざった保存済み回答を検知する', () => {
    const incidents = detectStoredCoachingQualityIncidents({
      messages: [
        message('u1', 'user', '今日は仕事について相談します。', 1),
        message(
          'a1',
          'assistant',
          '以下は過去の会話の保存済み要約です。前回までの保存済み要約: 家計の相談。',
          2
        ),
      ],
      candidateAssistantMessageIds: new Set(['a1']),
    });

    expect(incidents).toEqual([
      expect.objectContaining({
        assistantMessageId: 'a1',
        issue: 'internal_context_exposure',
        details: expect.objectContaining({ delivered: true }),
      }),
    ]);
  });

  it('利用者が話題ずれを指摘した後も同じ回答を返した場合を検知する', () => {
    const repeated =
      '現在の支払い分担について、口頭のお願い以外に確認できる合意や記録はありますか？';
    const incidents = detectStoredCoachingQualityIncidents({
      messages: [
        message('u1', 'user', '家計の相談です。', 1),
        message('a1', 'assistant', repeated, 2),
        message('u2', 'user', '何の話？今日は仕事の相談です。', 3),
        message('a2', 'assistant', repeated, 4),
        message('u3', 'user', '同じ返事で意味がわかりません。', 5),
        message('a3', 'assistant', repeated, 6),
      ],
      candidateAssistantMessageIds: new Set(['a2', 'a3']),
    });

    expect(incidents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assistantMessageId: 'a2',
          issue: 'repeated_response_after_dissatisfaction',
        }),
        expect.objectContaining({
          assistantMessageId: 'a3',
          issue: 'repeated_response_three_times',
        }),
      ])
    );
  });

  it('利用範囲外の同じ固定案内は品質事故として数えない', () => {
    const incidents = detectStoredCoachingQualityIncidents({
      messages: [
        message('u1', 'user', '翻訳して', 1),
        message('a1', 'assistant', COACHING_SCOPE_GUIDANCE, 2),
        message('u2', 'user', 'やっぱり翻訳して', 3),
        message('a2', 'assistant', COACHING_SCOPE_GUIDANCE, 4),
        message('u3', 'user', 'お願い', 5),
        message('a3', 'assistant', COACHING_SCOPE_GUIDANCE, 6),
      ],
      candidateAssistantMessageIds: new Set(['a1', 'a2', 'a3']),
    });

    expect(incidents).toEqual([]);
  });

  it('同文反復でなくても直前の相談と噛み合わない回答を検知する', () => {
    const incidents = detectStoredCoachingQualityIncidents({
      messages: [
        message(
          'u1',
          'user',
          '家計簿をつけていますが、今月8,166円の赤字になった原因を確認したいです。',
          1
        ),
        message(
          'a1',
          'assistant',
          '職場で評価を上げるには、上司へ進捗をこまめに共有し、次の会議で担当業務の成果を説明すると判断されやすくなります。まずは企画書の冒頭を一行書いてください。',
          2
        ),
      ],
      candidateAssistantMessageIds: new Set(['a1']),
    });

    expect(incidents).toEqual([
      expect.objectContaining({
        assistantMessageId: 'a1',
        issue: 'post_delivery_quality_failure',
        details: expect.objectContaining({
          qualityIssues: expect.arrayContaining(['context_mismatch']),
        }),
      }),
    ]);
  });

  it('複数利用者の履歴を混ぜずセッションごとに判定する', () => {
    const otherSessionId = '33333333-3333-4333-8333-333333333333';
    const incidents = detectStoredCoachingQualityIncidents({
      messages: [
        message(
          'u-work',
          'user',
          '上司との会議で提案をどう説明するか相談したいです。',
          1,
          SESSION_ID
        ),
        message(
          'u-home',
          'user',
          '家計簿で今月8,166円の赤字になった原因を確認したいです。',
          2,
          otherSessionId
        ),
        message(
          'a-work',
          'assistant',
          '会議では、提案の目的、期待できる効果、上司に判断してほしい点の順で説明すると要点が伝わります。まず、上司に判断してほしい内容を一文で書いてください。',
          3,
          SESSION_ID
        ),
      ],
      candidateAssistantMessageIds: new Set(['a-work']),
    });

    expect(incidents).toEqual([]);
  });

  it('10分監査は実ユーザーの事故だけを一意キーで永続化する', async () => {
    const userId = '22222222-2222-4222-8222-222222222222';
    const messages = [
      message(
        'u1',
        'user',
        '家計簿の赤字8,166円の原因を確認したいです。',
        1
      ),
      message(
        'a1',
        'assistant',
        '職場で評価を上げるには、上司へ進捗を共有し、会議で担当業務の成果を説明してください。まず企画書の冒頭を書いてください。',
        2
      ),
    ];
    const upserts: Array<{
      rows: Array<Record<string, unknown>>;
      options: Record<string, unknown>;
    }> = [];
    let chatSelectCalls = 0;
    const client = {
      from(table: string) {
        if (table === 'chat_messages') {
          chatSelectCalls += 1;
          const result = chatSelectCalls === 1 ? [messages[1]] : messages;
          const chain = fluentResult(result);
          return { select: () => chain };
        }
        if (table === 'chat_sessions') {
          return {
            select: () =>
              fluentResult([
                { id: SESSION_ID, user_id: userId, title: '家計の相談' },
              ]),
          };
        }
        if (table === 'profiles') {
          return {
            select: () =>
              fluentResult([{ id: userId, email: 'member@example.jp' }]),
          };
        }
        if (table === 'coaching_quality_incidents') {
          return {
            upsert(
              rows: Array<Record<string, unknown>>,
              options: Record<string, unknown>
            ) {
              upserts.push({ rows, options });
              return {
                select: async () => ({
                  data: rows.map((_, index) => ({ id: `incident-${index}` })),
                  error: null,
                }),
              };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    };

    const result = await auditRecentStoredCoachingResponses(
      client as never,
      { now: new Date('2026-08-04T00:10:00.000Z') }
    );

    expect(result).toMatchObject({
      scannedResponses: 1,
      scannedSessions: 1,
      detectedIncidents: 1,
      persistedIncidents: 1,
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].options).toEqual({
      onConflict: 'assistant_message_id,issue',
      ignoreDuplicates: true,
    });
    expect(upserts[0].rows[0]).toMatchObject({
      assistant_message_id: 'a1',
      session_id: SESSION_ID,
      user_id: userId,
      issue: 'post_delivery_quality_failure',
      source: 'scheduled_audit',
    });
    expect(JSON.stringify(upserts[0].rows[0])).not.toContain(
      messages[0].content
    );
    expect(JSON.stringify(upserts[0].rows[0])).not.toContain(
      messages[1].content
    );
  });
});

function fluentResult(data: Array<Record<string, unknown>>) {
  const chain = {
    eq() {
      return chain;
    },
    in() {
      return chain;
    },
    gte() {
      return chain;
    },
    lte() {
      return chain;
    },
    order() {
      return chain;
    },
    range: async () => ({ data, error: null }),
    then(
      resolve: (value: { data: Array<Record<string, unknown>>; error: null }) =>
        unknown
    ) {
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return chain;
}

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  second: number,
  sessionId = SESSION_ID
) {
  return {
    id,
    session_id: sessionId,
    role,
    content,
    created_at: `2026-08-04T00:00:${String(second).padStart(2, '0')}.000Z`,
  };
}
