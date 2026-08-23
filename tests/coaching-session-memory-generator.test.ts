import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  getGenerativeModel: vi.fn(),
  generateContent: vi.fn(),
}));

vi.mock('@/lib/openai', () => ({
  getGenAI: () => ({
    getGenerativeModel: mockState.getGenerativeModel,
  }),
}));

import {
  generateCoachingSessionMemoryStructure,
  parseCoachingSessionMemoryStructure,
  renderCoachingSessionMemoryStructure,
} from '../src/lib/coaching-session-memory-generator';

describe('coaching session memory generator', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    mockState.generateContent.mockReset();
    mockState.getGenerativeModel.mockReset();
    mockState.getGenerativeModel.mockReturnValue({
      generateContent: mockState.generateContent,
    });
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it('本人が明言した事実・未解決点・特徴語を構造化する', async () => {
    mockState.generateContent.mockResolvedValue({
      response: {
        text: () =>
          JSON.stringify({
            situationFacts: ['来月から勤務時間が変わる'],
            coreConcernAndHope: ['生活リズムを崩したくない'],
            triedRejectedAndAnswered: ['早寝の提案は難しいと回答した'],
            unresolvedIssues: ['通勤時間を含む予定は未確定'],
            currentTopic: '勤務時間変更への対応',
            previousTopics: ['家計の見直し'],
            distinctiveWords: [
              '朝が勝負',
              '詰め込みたくない',
              '余白が必要',
              '焦ると止まる',
              '一つずつ',
              '6件目は保存しない',
            ],
          }),
      },
    });

    const result = await generateCoachingSessionMemoryStructure({
      previousSummary: '以前は家計の見直しについて話した。',
      sourceMessages: [
        { role: 'user', content: '来月から勤務時間が変わります。' },
        { role: 'assistant', content: '早寝はできますか？' },
        { role: 'user', content: 'それは難しいです。朝が勝負です。' },
      ],
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      situationFacts: ['来月から勤務時間が変わる'],
      currentTopic: '勤務時間変更への対応',
      distinctiveWords: [
        '朝が勝負',
        '詰め込みたくない',
        '余白が必要',
        '焦ると止まる',
        '一つずつ',
      ],
    });
    expect(mockState.getGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        generationConfig: expect.objectContaining({
          temperature: 0.2,
          topP: 0.9,
          thinkingConfig: { thinkingLevel: 'low' },
          responseMimeType: 'application/json',
        }),
      })
    );
    expect(mockState.generateContent).toHaveBeenCalledWith(
      expect.stringContaining('来月から勤務時間が変わります')
    );
  });

  it('壊れたJSONや中身のない結果は保存対象にしない', () => {
    expect(parseCoachingSessionMemoryStructure('{bad')).toBeNull();
    expect(
      parseCoachingSessionMemoryStructure(
        JSON.stringify({
          situationFacts: [],
          coreConcernAndHope: [],
          triedRejectedAndAnswered: [],
          unresolvedIssues: [],
          currentTopic: '',
          previousTopics: [],
          distinctiveWords: [],
        })
      )
    ).toBeNull();
  });

  it('要約モデルが制限時間内に返らなければnullを返してフォールバック可能にする', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockState.generateContent.mockReturnValue(new Promise(() => undefined));

    const result = await generateCoachingSessionMemoryStructure({
      previousSummary: '',
      sourceMessages: [{ role: 'user', content: '合成した相談です。' }],
      timeoutMs: 5,
    });

    expect(result).toBeNull();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('coaching_session_memory_llm_failed')
    );
    warning.mockRestore();
  });

  it('構造化メモリを会話文脈用の明示的な見出しへ変換する', () => {
    const rendered = renderCoachingSessionMemoryStructure({
      situationFacts: ['事実A'],
      coreConcernAndHope: ['希望A'],
      triedRejectedAndAnswered: ['拒否済みA'],
      unresolvedIssues: ['未解決A'],
      currentTopic: '現在A',
      previousTopics: ['以前A'],
      distinctiveWords: ['本人の言葉A'],
    });

    expect(rendered).toContain('本人の状況・事実:\n- 事実A');
    expect(rendered).toContain('試したこと・拒否した提案・回答済みの質問');
    expect(rendered).toContain('本人が使った特徴的な言葉');
  });
});
