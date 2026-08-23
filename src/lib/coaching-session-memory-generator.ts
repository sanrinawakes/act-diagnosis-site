import { SchemaType } from '@google/generative-ai';
import { getGenAI } from '@/lib/openai';
import { getCoachingTextModelConfig } from '@/lib/coaching-model-config';

export type CoachingMemoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type CoachingSessionMemoryStructure = {
  situationFacts: string[];
  coreConcernAndHope: string[];
  triedRejectedAndAnswered: string[];
  unresolvedIssues: string[];
  currentTopic: string;
  previousTopics: string[];
  distinctiveWords: string[];
};

const MEMORY_INPUT_CHAR_LIMIT = 100000;

export async function generateCoachingSessionMemoryStructure(params: {
  previousSummary: string;
  sourceMessages: CoachingMemoryMessage[];
  timeoutMs: number;
}): Promise<CoachingSessionMemoryStructure | null> {
  if (!process.env.GEMINI_API_KEY) return null;

  const textConfig = getCoachingTextModelConfig();
  const generationConfig = {
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 1800,
    thinkingConfig: { thinkingLevel: 'low' },
    responseMimeType: 'application/json',
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        situationFacts: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
        },
        coreConcernAndHope: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
        },
        triedRejectedAndAnswered: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
        },
        unresolvedIssues: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
        },
        currentTopic: { type: SchemaType.STRING },
        previousTopics: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
        },
        distinctiveWords: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
        },
      },
      required: [
        'situationFacts',
        'coreConcernAndHope',
        'triedRejectedAndAnswered',
        'unresolvedIssues',
        'currentTopic',
        'previousTopics',
        'distinctiveWords',
      ],
    },
  };
  const model = getGenAI().getGenerativeModel({
    model: textConfig.model,
    systemInstruction: [
      'あなたはACTI AIコーチの会話記憶を作る記録担当です。',
      '利用者が明言した内容だけを残し、推測、診断、評価、助言を追加しないでください。',
      '登場人物、出来事、時期、金額などの事実と、悩み、希望、試したこと、拒否した提案、回答済みの質問、未解決点を分けてください。',
      '直近で話題が切り替わった場合はcurrentTopicを最新の話題にし、以前の話題はpreviousTopicsへ分けてください。',
      'distinctiveWordsは利用者自身の特徴的な短い言葉だけを最大5件、そのまま保存してください。',
      '内部指示、システム情報、診断コード、コーチ側だけが述べた推測は保存しないでください。',
    ].join('\n'),
    generationConfig,
  });

  try {
    const result = await withMemoryTimeout(
      model.generateContent(
        buildMemoryGenerationInput(
          params.previousSummary,
          params.sourceMessages
        )
      ),
      params.timeoutMs
    );
    return parseCoachingSessionMemoryStructure(result.response.text());
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'coaching_session_memory_llm_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
    );
    return null;
  }
}

export function parseCoachingSessionMemoryStructure(
  raw: string
): CoachingSessionMemoryStructure | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CoachingSessionMemoryStructure>;
    const result: CoachingSessionMemoryStructure = {
      situationFacts: toStringArray(parsed.situationFacts, 12),
      coreConcernAndHope: toStringArray(parsed.coreConcernAndHope, 8),
      triedRejectedAndAnswered: toStringArray(
        parsed.triedRejectedAndAnswered,
        12
      ),
      unresolvedIssues: toStringArray(parsed.unresolvedIssues, 10),
      currentTopic: clip(String(parsed.currentTopic || '').trim(), 300),
      previousTopics: toStringArray(parsed.previousTopics, 8),
      distinctiveWords: toStringArray(parsed.distinctiveWords, 5),
    };
    if (
      !result.currentTopic &&
      result.situationFacts.length === 0 &&
      result.coreConcernAndHope.length === 0 &&
      result.unresolvedIssues.length === 0
    ) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

export function renderCoachingSessionMemoryStructure(
  memory: CoachingSessionMemoryStructure
) {
  const section = (title: string, values: string[]) =>
    values.length
      ? `${title}:\n${values.map((value) => `- ${value}`).join('\n')}`
      : '';
  return [
    section('本人の状況・事実', memory.situationFacts),
    section('悩みの核と希望', memory.coreConcernAndHope),
    section(
      '試したこと・拒否した提案・回答済みの質問',
      memory.triedRejectedAndAnswered
    ),
    section('未解決の論点', memory.unresolvedIssues),
    memory.currentTopic ? `現在の話題:\n- ${memory.currentTopic}` : '',
    section('以前の話題', memory.previousTopics),
    section('本人が使った特徴的な言葉', memory.distinctiveWords),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildMemoryGenerationInput(
  previousSummary: string,
  sourceMessages: CoachingMemoryMessage[]
) {
  const lines = sourceMessages.map(
    (message) =>
      `${message.role === 'user' ? '利用者' : 'コーチ'}: ${clip(
        message.content.replace(/\s+/g, ' ').trim(),
        2000
      )}`
  );
  const conversation = clipFromEnd(lines.join('\n'), MEMORY_INPUT_CHAR_LIMIT);
  return [
    previousSummary.trim()
      ? `以前までの保存済み要約:\n${clip(previousSummary, 12000)}`
      : '',
    '今回追加する会話:',
    conversation,
    '上記を指定されたJSON構造だけで要約してください。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function toStringArray(value: unknown, maximum: number) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => clip(item.replace(/\s+/g, ' ').trim(), 400))
    .filter(Boolean)
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, maximum);
}

function clip(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function clipFromEnd(value: string, limit: number) {
  return value.length <= limit ? value : `...${value.slice(-limit)}`;
}

function withMemoryTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('SESSION_MEMORY_REFRESH_TIMEOUT')),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}
