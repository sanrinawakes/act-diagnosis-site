import { stripJapaneseQuotationContent } from '@/lib/coaching-quotation-language.mjs';
import { getGenAI } from '@/lib/openai';
import {
  stripAttachmentMarkdown,
  type InlineImageAttachment,
} from '@/lib/attachments';
import { sendCoachingAlert } from '@/lib/coaching-alerts';
import { COACHING_SCOPE_GUIDANCE } from '@/lib/coaching-scope';
import {
  COACHING_IMAGE_MODEL,
  COACHING_IMAGE_TEMPERATURE,
  COACHING_IMAGE_THINKING_LEVEL,
  COACHING_IMAGE_TOP_P,
  DEFAULT_COACHING_TEXT_MODEL,
  DEFAULT_COACHING_TEXT_THINKING_LEVEL,
  GEMINI_IMAGE_TIMEOUT_MS,
  getCoachingTextModelConfig,
} from '@/lib/coaching-model-config';

export interface CoachingChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CoachingUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  thoughts_tokens?: number;
  total_tokens?: number;
}

// The only two findings that may replace model output. Everything else about
// an answer is the model's responsibility and is judged by reading real
// conversations, not by rules here.
export type CoachingQualityIssue =
  | 'internal_context_exposure'
  | 'unsafe_high_impact_advice';

export interface CoachingQualityAssessment {
  issues: CoachingQualityIssue[];
}

// Fixed customer-facing texts. These, together with the urgent safety guidance
// in buildUrgentSafetyResponse, are the only texts that may replace or stand
// in for model output.
const INTERNAL_PROMPT_GUARD_RESPONSE =
  'その内容は公開できません。代わりに、今抱えている悩みや目標について一緒に考えます。今いちばん相談したいことは何ですか？';
const UNSAFE_HIGH_IMPACT_ADVICE_NOTICE =
  '申し訳ありません。いまの回答には、生活への影響が大きい手続きを、条件や合意を確認しないまま進める内容が含まれていたため、お伝えするのを控えました。確認できている事実と、相手との合意の内容を教えてください。';
const GENERATION_UNAVAILABLE_NOTICE =
  '申し訳ありません。いま回答を作成できませんでした。少し時間をおいて、もう一度お送りください。';

export interface CoachingTelemetry {
  route: string;
  requestId: string;
  requestMessages: number;
  compactMessages: number;
  historyMessages: number;
  attachments: number;
  lastUserChars: number;
  preStreamMs?: number;
  attachmentMs?: number;
  accountLookupMs?: number;
  sessionCorrelationId?: string | null;
}

type GeminiRole = 'user' | 'model';

type GeminiTextPart = { text: string };
type GeminiImagePart = { inlineData: { mimeType: string; data: string } };
export type GeminiPart = GeminiTextPart | GeminiImagePart;

type GeminiHistoryItem = {
  role: GeminiRole;
  parts: GeminiTextPart[];
};

const RECENT_HISTORY_LIMIT = 20;
const SUMMARY_CHAR_LIMIT = 1800;
const MEMORY_HISTORY_CHAR_LIMIT = 1800;
const HISTORY_MESSAGE_CHAR_LIMIT = 2000;
const API_HISTORY_LIMIT = 32;
const API_HISTORY_CHAR_LIMIT = 2000;
const API_LAST_USER_CHAR_LIMIT = 2500;
// Provider and finalization timeouts remain bounded independently so the
// request stays below the route's 60-second runtime limit.
const GEMINI_FINALIZE_TIMEOUT_MS = 4000;
const EXTERNAL_FALLBACK_TIMEOUT_MS = 10000;
const EXTERNAL_IMAGE_FALLBACK_TIMEOUT_MS = 15000;
const LONG_HISTORY_FALLBACK_HEDGE_DELAY_MS = 250;
const GEMINI_RETRY_DELAYS_MS = [300];
const ALERT_SLOW_RESPONSE_MS = 10000;
const ALERT_THROTTLE_MS = 5 * 60 * 1000;
export const COACHING_TEXT_MODEL = DEFAULT_COACHING_TEXT_MODEL;
export { COACHING_IMAGE_MODEL };
export const COACHING_MAX_OUTPUT_TOKENS = 4096;
export const COACHING_TEXT_THINKING_LEVEL =
  DEFAULT_COACHING_TEXT_THINKING_LEVEL;
const PARTIAL_STREAM_TIMEOUT_NOTICE =
  '\n\n（応答処理に時間がかかったため、ここで一度区切っています。続きが必要な場合は、「続き」と入力するとここから再開できます。）';
export const COACHING_RESPONSE_SPEED_INSTRUCTION = [
  '',
  '---',
  '## 利用範囲の厳守',
  '- ACTIは、ACT診断に基づく自己理解と、本人の感情・行動・人間関係・仕事の相談専用です。',
  '- 一般的な文章添削、広告や販売文章の作成、翻訳、外部調査、プログラム作成、画像生成は実行しないでください。',
  `- 利用範囲外の依頼を検出した場合は、依頼内容へ回答せず、次の案内だけを返してください。「${COACHING_SCOPE_GUIDANCE}」`,
  '',
  '## 応答速度と安定性のための追加ルール',
  '- 220〜420字は、説明が必要な通常相談での上限目安であり、埋めるべき目標ではない。新しい事実が一つ追加された時、短い返答を受けた時、深掘りの質問を求められた時、一つの答えを求められた時は、会話を一段進めるために必要な長さで短く返す。',
  '- 質問が複数ある場合は、すべてを一度に深掘りせず、最初の1つを中心に、ただし本人の話の流れを切らないように返す。',
  '- 長い前置き、網羅的な一覧、同じタイプ説明の繰り返しを避ける。診断情報や一般論から本人の感情・動機・価値観を補わず、本人が話した事実だけを使う。',
  '- 本人が書いていない感情、動機、物、人物、作業を足さない。相手側の行動を本人側の不足へ言い換えない。',
  '- 履歴にあるAI自身の推測は事実ではない。本人が明確に認めていない心理説明を引き継がず、最新の本人の訂正・拒否・感情を優先する。',
  '- 次の一手は質問一つ、または具体的な提案一つのどちらかにする。質問を置く返答には行動提案を足さず、提案を置く返答には確認質問を足さない。本人が両方を明示的に求めた場合だけ例外とする。',
  '- 本人が深掘りの質問を求めた時は、謝罪や一般論を付けず、直前までに本人が話した対象へ直接つながる具体的な質問一つだけを返す。',
  '- 直前の提案を拒否された時は、その提案や同じ意味の質問を繰り返さず、別の見立てまたは選択肢を示す。',
  '- 具体策を求められた時は質問を返さず、直前までの人物・作業・決めた言葉に直接つながる一動作を答える。',
  '- 「ご自身」「教えていただけますか」「お見受けします」「という事実があるのですね」を使わず、自然な「あなた」「教えてください」「感じているんですね」で話す。',
  '- 本人の発言を受け止める文では、「作成されている」「迷われている」のような接客敬語へ変えず、本人が使った「作っている」「迷っている」を自然な常体のまま使う。',
  '- 「短く答えて」など形式だけの変更では、現在の話題で本人が指定した行動と実行日を保持する。「明日」を「今」へ変えない。本人が日付を訂正・撤回した場合や話題を変えた場合は最新の指定を優先する。',
  '- 本人が「行動を一つ提案し、最後に質問を一つ」と両方を明示した場合は、提案一つの後に質問一つを必ず置く。どちらかを省略しない。',
  '- 一つの質問へ二択を入れず、「AとBのどちらですか」「言葉や内容」「作業や関係性」と聞かない。答えてほしい対象を一つにする。',
  '- 同じ名詞や優先順位の語を一文の中で必要なく重ねない。',
  '- 本人が書いていない感情や因果を共感として補わない。',
  '- 本人が明言した感情を、近い別の感情へ言い換えたり追加したりしない。本人の感情を評価する表現も足さない。',
  '- 「気持ちを受け止めます」「状況を受け止めます」のようにAI側の姿勢を宣言しない。本人が話した感情や事実を一文でそのまま拾う。',
  '- 具体的な出来事と感情を本人がすでに述べた後は、どの場面でその感情になったかを聞き直さない。相手に変えてほしい行動、またはその場で優先したい対応を一つ尋ねる。',
  '- ユーザーが一言や言い方を求めていない段階では、引用文や伝え方を先回りして提案しない。今の発言に直接つながる質問または整理で一段だけ進める。',
  '- 質問で閉じる返答には、「一つずつ確認していきましょう」「整理していきましょう」「話していきましょう」のような進行宣言を質問前へ足さない。質問一つで会話を進める。',
  '- 返答本文では「〜していきましょう」という進行宣言を使わない。本人の発言へ直接つながる理解または一問から始める。',
  '- 具体的な提案の前に「方法があります」「提案があります」と予告しない。実行する一文を直接示す。',
  '- 支払い、契約、法的手続きなど生活への影響が大きい相談では、条件や合意を確認せず、支払い停止、契約変更、名義変更などの高影響の手続きを提案しない。確認できる事実と合意を整理し、必要なら公的・専門窓口への相談を案内する。',
  '- 質問や行動提案が会話を前へ進めない時は、無理に付け足さず、具体的な理解と役に立つ整理で自然に閉じる。',
].join('\n');

const COACHING_FACT_AND_LANGUAGE_INSTRUCTION = [
  '断りたい予定や返事の先延ばしという出来事だけから、「ずっと頭のどこかで気になる」「過ごしづらい」など持続的な気掛かりや生活への影響を付け足さないでください。「ですよね」という同意を求める形でも未申告の状態を前提にします。本人が現在の話題で明言した状態だけを使い、気掛かりと生活への影響を別々に確かめてください。出来事そのものを短く受け止め、必要なら未申告の心理を含めない中立的な質問にしてください。',
  '資料を作成中、説明が長いという報告だけから、実際の本文、盛り込んだ特徴やメリット、一文に詰め込んだ構造を推測しないでください。本文や構造を本人が提示していても、それだけで長くなった原因とは断定しないでください。本人が同じ資料について明言した因果と、一般的な可能性・条件付きの例を区別してください。AI自身の推測、第三者の資料、引用した一般例を本人の資料の事実へ変えないでください。',
  '本人が友人への断り返事を先延ばしにし、断った後の関係を気にしている時は、本人の返事や予想している反応を扱ってください。本人が相手の行動変更を求めていないのに、相手にどの行動を変えてほしいかを尋ねないでください。相手の行動を変えてほしいという本人の明示的な希望とは区別してください。資料を作成する第三者の予定を報告しているだけの場合も、相手の行動変更を求めていると解釈しないでください。',
  '現在の曜日や今日・明日の日付は、利用者が示していない場合に推測しないでください。明示された締切をそのまま使い、現在の曜日を補わないでください。',
  '締切が分かっても、残作業量・所要時間・使える時間が未確認なら、期限に間に合うとも間に合わないとも断定しないでください。資料の構成案があることだけでも、完成の見込みは断定できません。条件文・誘導する質問・相手への返答例にも新しい保証を足さず、必要な作業と時間を確認してください。見積もりがある場合も確実な結果とは扱わず、その前提と不確実性を示してください。締切は現在の話題で利用者が最後に明言したものだけを使い、訂正・否定された期限やAI側の発言を根拠にしないでください。',
  '自分が前回何を質問・提案したかを、会話履歴にない内容で説明したり謝罪したりしないでください。話を聞いてほしいという希望には、今の希望に沿って返答してください。',
  '利用者が希望した金額や負担と、相手が了承した金額や負担を混同しないでください。希望を伝えたことだけから、合意や約束が成立したとは扱わず、合意の有無が不明ならその有無を確認してください。',
  '迷いや理由を話したいという希望だけから、「心がかき乱される」「激しく動揺している」など感情の種類や強さを追加しないでください。本人が明言した感情をその強さのまま使い、第三者の言葉やAI自身の以前の推測を本人の状態へ変えないでください。',
  '出来事や希望の報告だけから、本人が迷っている、困っている、不安であるとは扱わないでください。「どの言葉の言い換えに迷っていますか」「どのような対応で迷っていますか」のような問いも状態を前提にします。現在の話題で本人が述べた状態だけを使い、否定・訂正や第三者の発言、AI自身の推測を根拠にしないでください。未申告なら「どの言葉を言い換えたいですか」のように本人の希望を中立的に尋ねてください。',
  '行動を一つ求められた場合は、何にどう手を動かすかを示してください。「最初に行う作業に着手してください」のように依頼を言い換えるだけで終えないでください。既に伝えた締切時刻も踏まえるよう明示された場合は、現在の話題で本人が最後に示した時刻を返答にも残してください。',
  '怖いという本人の感情だけから、実際に言葉を出せず止まっている、何を言っても再び否定される、具体的な指摘を受けて直す必要があるとは扱わないでください。新しい家の相談では、出来事を聞く前に停止状況を補わないでください。AI自身の提案は本人が実行した事実ではありません。行動を提案する際も、本人が述べていない残作業や作成済みリストを前提にせず、必要なら新しく一つ書く動作にしてください。',
  '出力前に各文を読み返し、動詞の重複、助詞・接続語の欠落、数量への無関係な英単語の混入を除いてください。利用者が述べていない感情は断定しないでください。',
].join('\n');

const alertLastSentAt = new Map<string, number>();

export function getCoachingGeminiModelName(parts: GeminiPart[]) {
  return parts.some((part) => 'inlineData' in part)
    ? COACHING_IMAGE_MODEL
    : getCoachingTextModelConfig().model;
}

export function getCoachingGeminiModel(
  systemPrompt: string,
  modelName = getCoachingTextModelConfig().model,
  isImageRequest = false
) {
  const textConfig = getCoachingTextModelConfig();
  const generationConfig = {
    temperature: isImageRequest
      ? COACHING_IMAGE_TEMPERATURE
      : textConfig.temperature,
    topP: isImageRequest ? COACHING_IMAGE_TOP_P : textConfig.topP,
    maxOutputTokens: COACHING_MAX_OUTPUT_TOKENS,
    thinkingConfig: {
      thinkingLevel: isImageRequest
        ? COACHING_IMAGE_THINKING_LEVEL
        : textConfig.thinkingLevel,
    },
  };

  return getGenAI().getGenerativeModel({
    model: modelName,
    systemInstruction: `${systemPrompt}${COACHING_RESPONSE_SPEED_INSTRUCTION}\n${COACHING_FACT_AND_LANGUAGE_INSTRUCTION}`,
    generationConfig,
  });
}

export function prepareGeminiHistory(
  messages: CoachingChatMessage[]
): GeminiHistoryItem[] {
  const savedMemory = messages.find(
    (message) =>
      message.role === 'user' &&
      message.content.startsWith('以下は過去の会話の保存済み要約です。')
  );
  const conversationMessages = messages.filter(
    (message) =>
      message !== savedMemory &&
      !(
        message.role === 'assistant' &&
        (isServiceNotice(message.content) || message.content.startsWith(
          '承知しました。保存済み要約を背景として踏まえ'
        ))
      )
  );
  const cleaned = messages
    .filter((message) => conversationMessages.includes(message))
    .map((message) => ({
      role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
      text: truncateHistoryText(
        stripAttachmentMarkdown(message.content).trim() ||
          (message.role === 'user' ? '画像を添付しました。' : '')
      ),
    }))
    .filter((message) => message.text);

  const recentMessages = cleaned.slice(-RECENT_HISTORY_LIMIT);
  const olderMessages = cleaned.slice(0, -RECENT_HISTORY_LIMIT);
  const history: GeminiHistoryItem[] = [];

  if (savedMemory) {
    history.push({
      role: 'user',
      parts: [
        {
          text: truncateSavedMemory(savedMemory.content),
        },
      ],
    });
    history.push({
      role: 'model',
      parts: [
        {
          text: '保存済みの事実と経緯を背景として保持し、直近の発言を優先します。',
        },
      ],
    });
  }

  if (olderMessages.length > 0) {
    history.push({
      role: 'user',
      parts: [
        {
          text: [
            '以下はこれまでの会話の背景です。これは新しい依頼ではありません。',
            '直近のやり取りを最優先しつつ、流れを失わないための文脈としてだけ使ってください。',
            '',
            buildConversationSummary(olderMessages),
          ].join('\n'),
        },
      ],
    });
    history.push({
      role: 'model',
      parts: [
        {
          text: '承知しました。背景として踏まえ、直近の会話を優先して自然に返答します。',
        },
      ],
    });
  }

  const firstUserIndex = recentMessages.findIndex(
    (message) => message.role === 'user'
  );
  const recentFromUser =
    firstUserIndex >= 0 ? recentMessages.slice(firstUserIndex) : [];
  const normalized = normalizeAlternatingHistory(recentFromUser);

  return [...history, ...normalized];
}

export function prepareGeminiRequestHistory(
  messages: CoachingChatMessage[],
  lastUserParts: GeminiPart[]
): GeminiHistoryItem[] {
  const hasImage = lastUserParts.some((part) => 'inlineData' in part);
  const lastUserText = extractTextFromParts(lastUserParts);

  // Current-image fact checks should be decided from the attached pixels.
  // Unrelated coaching turns can otherwise bias a short visual answer.
  if (hasImage && requestsFactualShortAnswer(lastUserText)) {
    return [];
  }

  return prepareGeminiHistory(messages);
}

export function buildGeminiParts(
  text: string,
  attachments: InlineImageAttachment[],
  historyMessages: CoachingChatMessage[] = []
): GeminiPart[] {
  const normalizedText = text.trim() || '添付画像について見てください。';
  const responseStyleHint = buildResponseStyleHint(
    normalizedText,
    attachments.length > 0
  );
  const continuityHint = buildConversationContinuityHint(
    normalizedText,
    historyMessages
  );
  const parts: GeminiPart[] = [
    {
      text: responseStyleHint
        ? `${normalizedText}\n\n${responseStyleHint}`
        : normalizedText,
    },
  ];

  if (continuityHint) {
    parts.push({ text: continuityHint });
  }

  attachments.forEach((attachment) => {
    parts.push({
      inlineData: {
        mimeType: attachment.mimeType,
        data: attachment.data,
      },
    });
  });

  return parts;
}

function buildResponseStyleHint(text: string, hasAttachments = false) {
  if (hasAttachments && requestsFactualShortAnswer(text)) {
    return '【内部応答形式】添付画像を実際に確認し、ユーザーが尋ねた事実だけを直接答えてください。利用範囲の説明、背景説明、追加質問、コーチング提案は付けないでください。';
  }

  if (requestsFactualShortAnswer(text)) {
    return '【内部応答形式】会話履歴に保存されている事実から、ユーザーが尋ねた答えだけを簡潔な一文で返してください。質問文の言い換え、背景説明、提案、追加質問は付けないでください。';
  }

  if (requestsDirectWording(text)) {
    return '【内部応答形式】直近の会話を読み直し、ユーザーが明言した具体的な事実・感情・希望を含む、そのまま使える一文を「」で一つだけ返してください。本人が話していない時刻、期限、事情、感情を足さず、補足説明や追加質問も付けないでください。';
  }

  if (
    requestsExplicitClosingQuestion(text) &&
    /方法|提案|行動|一歩|できること|どうすれば|どうしたら/.test(text)
  ) {
    return '【内部応答形式】ユーザーが明示的に求めた具体的な提案を一つ示し、その後に判断を深める質問を一つだけ置いてください。提案と質問はいずれも、直近の相談対象と指定された時機を保持し、別案、二択、一般論を足さないでください。';
  }

  if (requestsSingleAnswerFormat(text)) {
    return '【内部応答形式】ユーザーの指定を優先し、確認できている会話の事実に直接つながる答えまたは提案を一つだけ、一段落で簡潔に返してください。一つの提案へ複数の動作や別案を詰め込まず、履歴にない人物、物、場所、時刻、期限、作業名を足さないでください。補足説明や確認質問は付けず、答えた時点で終了してください。';
  }

  if (isFactualLifeChangeWithoutExplicitRequest(text)) {
    return '【内部応答形式】本人が追加した事実を一文で短く受け止めた後、その変化を本人がどう感じているか、具体的な質問一つだけで尋ねてください。本人がまだ話していない負担、感情、解決策を先回りせず、二択や追加提案も付けないでください。';
  }

  if (requestsRestWithoutQuestions(text)) {
    return '【内部応答形式】本人が明言した疲れや休みたい意思だけを短く受け止め、休んでよいと二文以内で伝えてください。状態や原因を広げず、別の提案、再開案内、質問は付けないでください。';
  }

  return '';
}

function isFactualLifeChangeWithoutExplicitRequest(text: string) {
  const hasExplicitRequest =
    /[？?]|(?:どうすれば|どうしたら|教えて|答えて|提案して|考えて|聞いてほしい|相談したい|助けて)/.test(
      text
    );
  const alreadyNamesFeeling =
    /腹が立|怒|嫌|悲し|不安|怖|つら|しんど|疲れ|戸惑|困|負担に感じ|うれし|嬉し|楽し/.test(
      text
    );
  const describesLifeChange =
    /勤務|始業|通勤|家事|育児|介護|引っ越|転居|家族|夫|妻|子ども|子供|親|生活時間|勤務時間/.test(
      text
    );
  const isPracticalTaskUpdate =
    /資料|企画書|原稿|ファイル|スライド|会議資料|締切|タスク|作業/.test(
      text
    );

  return (
    !hasExplicitRequest &&
    !alreadyNamesFeeling &&
    describesLifeChange &&
    !isPracticalTaskUpdate
  );
}

function buildConversationContinuityHint(
  text: string,
  historyMessages: CoachingChatMessage[]
) {
  const previousAssistant = [...historyMessages]
    .reverse()
    .find((message) => message.role === 'assistant')?.content;
  if (!previousAssistant) return '';

  const normalized = text.replace(/\s+/g, ' ').trim();
  const isShortContinuation = normalized.length <= 80;
  const rejectsPreviousMove =
    isShortContinuation &&
    /^(?:できない|無理|やりたくない|したくない|もうやっている|毎回(?:言って|伝えて)いる|何度も(?:言って|伝えて)いる)[。！!？?]*$/.test(
      normalized
    );
  const asksCoachToAnswer =
    /わからないから聞いて|それを聞いている|質問ばかり|同じ質問|答えになっていない|ちゃんと答えて|前(?:の|より).{0,20}(?:方が|ほうが).{0,20}(?:的確|良かった|よかった)|頭が悪くな/.test(
      normalized
    );
  const answersWithSilence =
    isShortContinuation && /^何も(?:言わない|答えない)[。！!？?]*$/.test(normalized);
  const tentativeAgreement =
    isShortContinuation &&
    /^(?:うん|はい|そう|そうかも|たぶん|かもしれない)(?:です|だと思います)?[。！!？?]*$/.test(
      normalized
    );

  if (
    !rejectsPreviousMove &&
    !asksCoachToAnswer &&
    !answersWithSilence &&
    !tentativeAgreement
  ) {
    return '';
  }

  const instructions = [
    '【内部会話継続指示】',
    `直前のコーチ発言: ${truncateForApiPrompt(previousAssistant, 500)}`,
    '- 最新発言を、直前までの人物・出来事と直前の質問または提案につながる返答として解釈する。',
    '- ユーザーが否定した提案や、すでに実行済みだと話した提案を言い換えて繰り返さない。',
    '- AI自身が以前に補った心理や推測を事実として引き継がず、最新の本人の発言で会話を一段だけ進める。',
  ];

  if (answersWithSilence) {
    instructions.push(
      '- 短い沈黙の返答では、直前の質問で尋ねた相手や対象を主語として引き継ぐ。ユーザー本人が話したくないという意味や、直前の提案を実行した結果へ勝手に変えない。',
      '- 新たに分かった「相手から説明や返答がない」という事実を短く受け止めた後、直前と同じ内容を聞き直さず、その事実の影響または次に確認したい一点を質問一つだけで尋ねる。'
    );
  }

  if (tentativeAgreement) {
    instructions.push(
      '- 短い同意は直前の内容への暫定的な回答として扱い、本人が話していない過去、原因、感情まで肯定した証拠にしない。',
      '- 直前と同じ質問を言い換えて繰り返さず、同じ相談対象に直接つながる具体的な質問一つだけで一段深める。'
    );
  }

  if (rejectsPreviousMove) {
    instructions.push(
      '- 拒否は直前の提案への拒否として扱い、人生全体の無気力や疲労へ意味を広げない。',
      '- 拒否された案を外し、確認済みの事実から別の見立てまたは別の選択肢を一つだけ示す。'
    );
  }

  if (asksCoachToAnswer) {
    instructions.push(
      '- 今回は追加質問を返さず、確認済みの事実に直接つながる具体的な答えを一つだけ示す。',
      '- 回答を予告する進行宣言、相談先や別案の列挙、本人が話していない条件の追加をしない。'
    );
  }

  return instructions.join('\n');
}

export function compactCoachingMessages(
  messages: CoachingChatMessage[]
): CoachingChatMessage[] {
  if (messages.length === 0) return [];

  const lastMessage = messages[messages.length - 1];
  const historyMessages = dedupeConsecutiveMessages(
    messages.slice(0, -1).filter((message) => !isGenericFailureMessage(message))
  ).slice(-API_HISTORY_LIMIT);

  return [
    ...historyMessages.map((message) => ({
      role: message.role,
      content: truncateForApiPrompt(message.content, API_HISTORY_CHAR_LIMIT),
    })),
    {
      role: lastMessage.role,
      content:
        truncateForApiPrompt(lastMessage.content, API_LAST_USER_CHAR_LIMIT) ||
        (lastMessage.role === 'user' ? '添付画像について見てください。' : '続けて聞かせてください。'),
    },
  ].filter((message) => message.content.trim());
}

export async function generateCoachingText(params: {
  systemPrompt: string;
  historyMessages: CoachingChatMessage[];
  lastUserParts: GeminiPart[];
}) {
  const lastUserText = extractTextFromParts(params.lastUserParts);
  const immediateResponse = buildImmediateCoachingResponse(lastUserText);
  if (immediateResponse) {
    return {
      ...toGenerationResult(buildImmediateResolution(immediateResponse)),
      completionStatus: 'complete' as const,
      finishReason: immediateResponse.finishReason,
    };
  }

  const modelName = getCoachingGeminiModelName(params.lastUserParts);
  const isImageRequest = params.lastUserParts.some(
    (part) => 'inlineData' in part
  );
  const geminiTimeoutMs = getGeminiTimeoutMs(isImageRequest);
  let result;
  try {
    result = await runWithGeminiRetry(async () => {
      const model = getCoachingGeminiModel(
        params.systemPrompt,
        modelName,
        isImageRequest
      );
      const chat = model.startChat({
        history: prepareGeminiRequestHistory(
          params.historyMessages,
          params.lastUserParts
        ),
      });

      return withTimeout(
        chat.sendMessage(params.lastUserParts, {
          timeout: geminiTimeoutMs,
        }),
        geminiTimeoutMs
      );
    });
  } catch (error) {
    const fallback = await tryExternalProviderFallback(params);
    if (fallback) {
      return {
        ...toGenerationResult(
          applyCoachingSafetyBoundaries({
            rawText: fallback.rawText,
            usage: fallback.usage,
            modelName: fallback.model,
            provider: fallback.provider,
          })
        ),
        completionStatus: 'complete' as const,
        finishReason: fallback.finishReason || 'EXTERNAL_FALLBACK',
      };
    }
    return {
      ...toGenerationResult(buildGenerationUnavailableResolution()),
      completionStatus: 'fallback' as const,
      finishReason: getErrorMessage(error),
    };
  }

  const response = result.response;
  const finishReason = getFinishReason(response);
  const completionStatus = classifyGeminiCompletion(finishReason);
  const rawText = readGeminiResponseText(response);
  if (completionStatus === 'complete' && !rawText.trim()) {
    throw new Error('GEMINI_EMPTY_RESPONSE');
  }
  if (!rawText.trim()) {
    // The model stopped for a non-STOP reason before producing any usable
    // text. Say so instead of improvising an answer.
    return {
      ...toGenerationResult(buildGenerationUnavailableResolution()),
      completionStatus,
      finishReason,
    };
  }

  return {
    ...toGenerationResult(
      applyCoachingSafetyBoundaries({
        rawText:
          completionStatus === 'partial'
            ? trimToNaturalContinuationBoundary(rawText)
            : rawText,
        usage: getUsage(response),
        modelName,
      })
    ),
    completionStatus,
    finishReason,
  };
}

export function createJsonLineStream(params: {
  systemPrompt: string;
  historyMessages: CoachingChatMessage[];
  lastUserParts: GeminiPart[];
  onDone: (
    usage: CoachingUsage,
    completion: CoachingCompletionDetails
  ) => Promise<Record<string, unknown>>;
  telemetry?: CoachingTelemetry;
}) {
  const encoder = new TextEncoder();
  const modelName = getCoachingGeminiModelName(params.lastUserParts);
  const lastUserText = extractTextFromParts(params.lastUserParts);
  let deliveryOpen = true;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullText = '';
      let emittedText = '';
      const startedAt = Date.now();
      let firstChunkMs: number | null = null;
      let generationFirstChunkMs: number | null = null;
      const fallbackAbortController = new AbortController();
      let fallbackHedgeTimer: ReturnType<typeof setTimeout> | null = null;
      let externalFallbackPromise: ReturnType<
        typeof tryExternalProviderFallback
      > | null = null;

      const startExternalFallback = () => {
        if (fallbackHedgeTimer) {
          clearTimeout(fallbackHedgeTimer);
          fallbackHedgeTimer = null;
        }
        if (fallbackAbortController.signal.aborted) {
          return Promise.resolve(null);
        }
        externalFallbackPromise ??= tryExternalProviderFallback({
          ...params,
          signal: fallbackAbortController.signal,
        });
        return externalFallbackPromise;
      };
      const stopExternalFallback = () => {
        if (fallbackHedgeTimer) {
          clearTimeout(fallbackHedgeTimer);
          fallbackHedgeTimer = null;
        }
        fallbackAbortController.abort();
      };

      const write = (payload: Record<string, unknown>) => {
        if (!deliveryOpen) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          deliveryOpen = false;
        }
      };

      const writeVerifiedChunk = (text: string) => {
        if (!text) return;
        firstChunkMs ??= Date.now() - startedAt;
        emittedText += text;
        write({ type: 'chunk', text, verified: true });
      };

      // Every outcome ends here: the final text is emitted once (model text is
      // never streamed before the safety boundaries have been checked), the
      // route finalizes usage, and a single `done` event closes the turn.
      const deliver = async (
        status: CoachingStreamStatus,
        resolution: CoachingQualityResolution,
        details: {
          completionStatus: CoachingCompletionDetails['completionStatus'];
          finishReason?: string;
          fallbackFrom?: string;
          ttftMs: number | null;
          error?: string;
        }
      ) => {
        fullText = resolution.text;
        if (!emittedText) writeVerifiedChunk(fullText);
        const finalization = await resolveDonePayload(
          params.onDone,
          resolution.usage,
          {
            message: fullText,
            completionStatus: details.completionStatus,
            finishReason: details.finishReason,
            modelName: resolution.modelName,
            provider: resolution.provider,
            qualityInitialIssues: resolution.initialIssues,
            qualityFinalIssues: resolution.finalIssues,
            qualitySafetyHold: resolution.qualitySafetyHold,
            chargeable: resolution.chargeable,
          }
        );
        logChatTelemetry(status, params.telemetry, {
          modelName: resolution.modelName,
          provider: resolution.provider,
          fallbackFrom: details.fallbackFrom,
          qualityInitialIssues: resolution.initialIssues,
          qualityFinalIssues: resolution.finalIssues,
          qualitySafetyHold: resolution.qualitySafetyHold,
          completionStatus: details.completionStatus,
          elapsedMs: Date.now() - startedAt,
          firstChunkMs,
          generationFirstChunkMs,
          ttftMs: details.ttftMs,
          finalizationStatus: finalization.status,
          finalizationMs: finalization.elapsedMs,
          finalizationError: finalization.error,
          outputChars: fullText.length,
          finishReason: details.finishReason,
          usage: resolution.usage,
          error: details.error,
        });
        write({
          type: 'done',
          modelName: resolution.modelName,
          provider: resolution.provider,
          fallbackFrom: details.fallbackFrom,
          qualityInitialIssues: resolution.initialIssues,
          qualityFinalIssues: resolution.finalIssues,
          qualitySafetyHold: resolution.qualitySafetyHold,
          completionStatus: details.completionStatus,
          finalizationStatus: finalization.status,
          finishReason: details.finishReason,
          message: fullText,
          usage: resolution.usage,
          ...finalization.payload,
        });
      };

      try {
        const immediateResponse = buildImmediateCoachingResponse(lastUserText);
        if (immediateResponse) {
          await deliver('done', buildImmediateResolution(immediateResponse), {
            completionStatus: 'complete',
            finishReason: immediateResponse.finishReason,
            ttftMs: null,
          });
          return;
        }

        const acceptGeneratedText = (text: string) => {
          if (!text) return;
          fullText += text;
          generationFirstChunkMs ??= Date.now() - startedAt;
        };

        let response:
          | {
              candidates?: Array<{ finishReason?: string }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                cachedContentTokenCount?: number;
                thoughtsTokenCount?: number;
                totalTokenCount?: number;
              };
            }
          | undefined;

        const isImageRequest = params.lastUserParts.some(
          (part) => 'inlineData' in part
        );
        if (
          !isImageRequest &&
          params.historyMessages.length >= 18 &&
          (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)
        ) {
          fallbackHedgeTimer = setTimeout(() => {
            void startExternalFallback();
          }, LONG_HISTORY_FALLBACK_HEDGE_DELAY_MS);
        }
        const geminiTimeoutMs = getGeminiTimeoutMs(isImageRequest);
        await runWithGeminiRetry(async () => {
          fullText = '';
          const model = getCoachingGeminiModel(
            params.systemPrompt,
            modelName,
            isImageRequest
          );
          const chat = model.startChat({
            history: prepareGeminiRequestHistory(
              params.historyMessages,
              params.lastUserParts
            ),
          });
          const result = await withTimeout(
            chat.sendMessageStream(params.lastUserParts, {
              timeout: geminiTimeoutMs,
            }),
            geminiTimeoutMs
          );

          try {
            await withTimeout(
              consumeGeminiStream(result.stream, (text) => {
                acceptGeneratedText(text);
              }),
              geminiTimeoutMs
            );
          } catch (streamError) {
            if (fullText.trim()) {
              if (
                streamError instanceof Error &&
                streamError.message === 'GEMINI_TIMEOUT'
              ) {
                throw streamError;
              }
              throw new Error('GEMINI_PARTIAL_STREAM_INTERRUPTED');
            }
            throw streamError;
          }

          response = await withTimeout(result.response, GEMINI_FINALIZE_TIMEOUT_MS);

          if (!fullText.trim()) {
            throw new Error('GEMINI_EMPTY_RESPONSE');
          }
        });

        if (!response) {
          throw new Error('GEMINI_EMPTY_RESPONSE');
        }

        const finishReason = getFinishReason(response);
        const completionStatus = classifyGeminiCompletion(finishReason);
        const resolution = applyCoachingSafetyBoundaries({
          rawText:
            completionStatus === 'partial'
              ? trimToNaturalContinuationBoundary(fullText)
              : fullText,
          usage: getUsage(response),
          modelName,
        });
        stopExternalFallback();
        await deliver(
          completionStatus === 'partial' ? 'partial_done' : 'done',
          resolution,
          {
            completionStatus,
            finishReason,
            ttftMs: generationFirstChunkMs,
          }
        );
      } catch (error) {
        const isTimeout =
          error instanceof Error && error.message === 'GEMINI_TIMEOUT';

        if (!emittedText) {
          const externalFallback = await startExternalFallback();
          if (externalFallback) {
            await deliver(
              'fallback_done',
              applyCoachingSafetyBoundaries({
                rawText: externalFallback.rawText,
                usage: externalFallback.usage,
                modelName: externalFallback.model,
                provider: externalFallback.provider,
              }),
              {
                completionStatus: 'complete',
                finishReason: externalFallback.finishReason ?? undefined,
                fallbackFrom: modelName,
                ttftMs:
                  generationFirstChunkMs ??
                  externalFallback.firstChunkMs ??
                  null,
                error: getErrorMessage(error),
              }
            );
            return;
          }
        }

        if (fullText.trim()) {
          // Gemini produced text before failing. Deliver what it said, cut at
          // a natural boundary, as a partial answer rather than replacing it.
          const partialText = trimToNaturalContinuationBoundary(fullText);
          await deliver(
            'partial_done',
            applyCoachingSafetyBoundaries({
              rawText: isTimeout
                ? `${partialText}${PARTIAL_STREAM_TIMEOUT_NOTICE}`
                : partialText,
              usage: {},
              modelName,
              provider: 'gemini',
            }),
            {
              completionStatus: 'partial',
              ttftMs: generationFirstChunkMs,
              error: getErrorMessage(error),
            }
          );
          return;
        }

        // Neither Gemini nor an external provider produced an answer. Tell
        // the customer so, honestly, instead of improvising a coaching reply.
        await deliver('fallback_done', buildGenerationUnavailableResolution(), {
          completionStatus: 'fallback',
          finishReason: 'LOCAL_FALLBACK',
          fallbackFrom: modelName,
          ttftMs: generationFirstChunkMs,
          error: getErrorMessage(error),
        });
      } finally {
        stopExternalFallback();
        if (deliveryOpen) {
          try {
            controller.close();
          } catch {
            deliveryOpen = false;
          }
        }
      }
    },
    cancel() {
      deliveryOpen = false;
    },
  });
}

export type CoachingCompletionDetails = {
  message: string;
  completionStatus: 'complete' | 'partial' | 'fallback';
  finishReason?: string;
  modelName: string;
  provider?: string;
  qualityInitialIssues?: CoachingQualityIssue[];
  qualityFinalIssues?: CoachingQualityIssue[];
  qualitySafetyHold?: boolean;
  chargeable?: boolean;
};

type CoachingStreamStatus =
  | 'done'
  | 'partial_done'
  | 'fallback_done'
  | 'error';

type CoachingTelemetryDetails = {
  completionStatus: 'complete' | 'partial' | 'fallback';
  elapsedMs: number;
  finalizationStatus: 'complete' | 'failed';
  [key: string]: unknown;
};

export function isRecoveredProviderFallback(
  status: CoachingStreamStatus,
  payload: Record<string, unknown>
) {
  return (
    status === 'fallback_done' &&
    payload.completionStatus === 'complete' &&
    payload.finalizationStatus === 'complete'
  );
}

export function shouldAlertForCoachingTelemetry(
  status: CoachingStreamStatus,
  payload: Record<string, unknown>
) {
  return getCoachingTelemetryLevel(status, payload) !== 'info';
}

export function getCoachingTelemetryLevel(
  status: CoachingStreamStatus,
  payload: Record<string, unknown>
) {
  const elapsedMs =
    typeof payload.elapsedMs === 'number' ? payload.elapsedMs : 0;
  const finalizationFailed = payload.finalizationStatus === 'failed';
  const qualityFailed =
    Array.isArray(payload.qualityFinalIssues) &&
    payload.qualityFinalIssues.length > 0;
  const qualitySafetyHold = payload.qualitySafetyHold === true;
  const recoveredProviderFallback = isRecoveredProviderFallback(
    status,
    payload
  );

  if (
    finalizationFailed ||
    qualityFailed ||
    qualitySafetyHold ||
    (status !== 'done' && !recoveredProviderFallback)
  ) {
    return 'error' as const;
  }
  if (elapsedMs >= ALERT_SLOW_RESPONSE_MS) {
    return 'warning' as const;
  }
  return 'info' as const;
}

function logChatTelemetry(
  status: CoachingStreamStatus,
  telemetry: CoachingTelemetry | undefined,
  details: CoachingTelemetryDetails
) {
  if (!telemetry) return;

  const payload = {
    event: `chat_stream_${status}`,
    ...telemetry,
    qualityObservedIssues:
      details.qualityObservedIssues ?? details.qualityInitialIssues ?? [],
    ...details,
  };

  const level = getCoachingTelemetryLevel(status, payload);
  const message = JSON.stringify(payload);

  if (level === 'error') {
    console.error(message);
    queueCoachingAlert(status, payload);
    return;
  }
  if (level === 'warning') {
    console.warn(message);
    queueCoachingAlert(status, payload);
    return;
  }

  console.info(message);
}

function queueCoachingAlert(
  status: CoachingStreamStatus,
  payload: Record<string, unknown>
) {
  const route = typeof payload.route === 'string' ? payload.route : 'unknown';
  const alertKind = getCoachingAlertThrottleKind(status, payload);
  const throttleKey = `${route}:${alertKind}`;
  const now = Date.now();
  const lastSentAt = alertLastSentAt.get(throttleKey) || 0;

  if (now - lastSentAt < ALERT_THROTTLE_MS) {
    return;
  }

  alertLastSentAt.set(throttleKey, now);
  const { subject, summary } = getCoachingAlertCopy(status, payload);

  void sendCoachingAlert({
    subject,
    summary,
    details: payload,
  });
}

export function getCoachingAlertThrottleKind(
  status: CoachingStreamStatus,
  payload: Record<string, unknown>
) {
  if (payload.finalizationStatus === 'failed') {
    return 'finalization_failed';
  }
  if (
    Array.isArray(payload.qualityFinalIssues) &&
    payload.qualityFinalIssues.length > 0
  ) {
    return 'quality_failed';
  }
  if (payload.qualitySafetyHold === true) {
    return 'quality_safety_hold';
  }
  if (isRecoveredProviderFallback(status, payload)) {
    return 'provider_fallback_recovered_slow';
  }
  return status;
}

export function getCoachingAlertCopy(
  status: CoachingStreamStatus,
  payload: Record<string, unknown>
) {
  const finalizationFailed = payload.finalizationStatus === 'failed';
  const qualityFailed =
    Array.isArray(payload.qualityFinalIssues) &&
    payload.qualityFinalIssues.length > 0;
  const qualitySafetyHold = payload.qualitySafetyHold === true;
  const recoveredProviderFallback = isRecoveredProviderFallback(
    status,
    payload
  );
  const elapsedMs =
    typeof payload.elapsedMs === 'number' ? payload.elapsedMs : 0;

  if (finalizationFailed) {
    return {
      subject: '[ACTI Bot] 会話後処理の失敗を検知しました',
      summary:
        'AIの回答生成後に、利用回数などの会話後処理を完了できませんでした。VercelログのrequestIdで詳細を確認してください。',
    };
  }
  if (qualityFailed) {
    return {
      subject: '[ACTI Bot] 回答品質の不合格を検知しました',
      summary:
        'AIの回答は生成されましたが、生成後の品質検査で未解決の問題を検知しました。VercelログのrequestIdとqualityFinalIssuesで回答内容を確認してください。',
    };
  }
  if (qualitySafetyHold) {
    return {
      subject: '[ACTI Bot] 不適切な回答の表示を自動停止しました',
      summary:
        '最終品質検査で安全に修正できない回答を検知し、問題のある本文は利用者へ表示せず、固定案内へ切り替えました。自動対応キューで原因を確認してください。',
    };
  }
  if (status === 'done') {
    return {
      subject: '[ACTI Bot] 応答遅延を検知しました',
      summary:
        'AIコーチングbotで応答遅延を検知しました。VercelログのrequestIdで詳細を確認してください。',
    };
  }
  if (recoveredProviderFallback) {
    if (elapsedMs >= ALERT_SLOW_RESPONSE_MS) {
      return {
        subject: '[ACTI Bot] 自動復旧しましたが応答が遅延しました',
        summary:
          '主系AIの生成が中断しましたが、予備AIが回答を完了し、会話履歴の保存も完了しました。利用者には回答が表示されていますが、応答時間が基準を超えたため確認してください。',
      };
    }
    return {
      subject: '[ACTI Bot] 予備AIへの自動切替を検知しました',
      summary:
        '主系AIの生成が中断しましたが、予備AIが回答を完了し、会話履歴の保存も完了しました。利用者には回答が表示されています。',
    };
  }

  return {
    subject: '[ACTI Bot] 応答失敗/中断を検知しました',
    summary:
      'AIコーチングbotで応答失敗または中断を検知しました。VercelログのrequestIdで詳細を確認してください。',
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function consumeGeminiStream(
  stream: AsyncIterable<{ text: () => string }>,
  onText: (text: string) => void
) {
  for await (const chunk of stream) {
    const text = chunk.text();
    if (text) onText(text);
  }
}

async function resolveDonePayload(
  onDone: (
    usage: CoachingUsage,
    completion: CoachingCompletionDetails
  ) => Promise<Record<string, unknown>>,
  usage: CoachingUsage,
  completion: CoachingCompletionDetails
) {
  const startedAt = Date.now();
  try {
    return {
      payload: await withTimeout(
        onDone(usage, completion),
        GEMINI_FINALIZE_TIMEOUT_MS,
        'CHAT_FINALIZE_TIMEOUT'
      ),
      status: 'complete' as const,
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    console.error('Failed to finalize chat stream metadata:', error);
    return {
      payload: {},
      status: 'failed' as const,
      elapsedMs: Date.now() - startedAt,
      error: getErrorMessage(error),
    };
  }
}

export function getStreamHeaders() {
  return {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  };
}

async function runWithGeminiRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        attempt >= GEMINI_RETRY_DELAYS_MS.length ||
        !shouldRetryGeminiError(error)
      ) {
        break;
      }

      await delay(GEMINI_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

function shouldRetryGeminiError(error: unknown) {
  if (error instanceof Error && error.message === 'GEMINI_TIMEOUT') {
    return false;
  }

  if (error instanceof Error && error.message === 'GEMINI_EMPTY_RESPONSE') {
    return true;
  }

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : 0;

  if ([429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  return [
    '429',
    '500',
    '502',
    '503',
    '504',
    'overloaded',
    'temporarily unavailable',
    'try again',
    'fetch failed',
    'econnreset',
    'etimedout',
    'rate limit',
  ].some((keyword) => message.includes(keyword));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAlternatingHistory(
  messages: Array<{ role: GeminiRole; text: string }>
): GeminiHistoryItem[] {
  const normalized: GeminiHistoryItem[] = [];

  messages.forEach((message) => {
    if (message.role === 'model' && normalized.length === 0) return;

    const previous = normalized[normalized.length - 1];
    if (previous?.role === message.role) {
      previous.parts[0].text = `${previous.parts[0].text}\n\n${message.text}`;
      return;
    }

    normalized.push({
      role: message.role,
      parts: [{ text: message.text }],
    });
  });

  if (normalized[normalized.length - 1]?.role === 'user') {
    normalized.push({
      role: 'model',
      parts: [{ text: '続けて聞かせてください。' }],
    });
  }

  return normalized;
}

function buildConversationSummary(
  messages: Array<{ role: GeminiRole; text: string }>
) {
  const text = messages
    .map((message) => {
      const label = message.role === 'user' ? 'ユーザー' : 'コーチ';
      return `${label}: ${message.text}`;
    })
    .join('\n');

  const compactText = compactLongLines(text);
  if (compactText.length <= SUMMARY_CHAR_LIMIT) return compactText;
  return compactText.slice(-SUMMARY_CHAR_LIMIT);
}

function compactLongLines(text: string) {
  return text
    .split('\n')
    .map((line) => (line.length > 260 ? `${line.slice(0, 260)}…` : line))
    .join('\n');
}

function truncateHistoryText(text: string) {
  if (text.length <= HISTORY_MESSAGE_CHAR_LIMIT) return text;
  return `${text.slice(0, HISTORY_MESSAGE_CHAR_LIMIT)}\n（長文のため一部省略）`;
}

function truncateSavedMemory(text: string) {
  if (text.length <= MEMORY_HISTORY_CHAR_LIMIT) return text;

  const headLength = Math.floor(MEMORY_HISTORY_CHAR_LIMIT * 0.55);
  const tailLength = MEMORY_HISTORY_CHAR_LIMIT - headLength;
  return `${text.slice(0, headLength)}\n（保存済み要約の中間を省略）\n${text.slice(
    -tailLength
  )}`;
}

function truncateForApiPrompt(content: string, limit: number) {
  const text = stripAttachmentMarkdown(content).trim();
  if (text.length <= limit) return text;
  return compactLongTextForApiPrompt(text, limit);
}

// Service notices (the outage notice, and the retired "please resend" notices
// that older stored histories still contain) are not conversation turns and
// must not be replayed to the model as its own earlier replies.
function isServiceNotice(text: string) {
  return /^申し訳ありません。[^\n]{0,200}?(?:もう一度(?:だけ)?(?:送って|お送り)ください|そのまま再送してください|新しいチャットを開いて)/.test(
    text.trim()
  );
}

function isGenericFailureMessage(message: CoachingChatMessage) {
  if (message.role !== 'assistant') return false;
  if (isServiceNotice(message.content)) return true;

  return [
    '応答に時間がかかりすぎたため中断しました',
    'すみません、応答に失敗しました',
    'AIの応答生成に失敗しました',
    'ログイン状態の確認に時間がかかりました',
    '会員情報の確認に時間がかかりました',
    '会員情報を確認できませんでした',
    'サーバーから回答を受け取れませんでした',
  ].some((text) => message.content.includes(text));
}

function dedupeConsecutiveMessages(messages: CoachingChatMessage[]) {
  const deduped: CoachingChatMessage[] = [];

  messages.forEach((message) => {
    const previous = deduped[deduped.length - 1];
    const normalizedContent = stripAttachmentMarkdown(message.content)
      .replace(/\s+/g, ' ')
      .trim();
    const previousContent = previous
      ? stripAttachmentMarkdown(previous.content).replace(/\s+/g, ' ').trim()
      : '';

    if (
      previous &&
      previous.role === message.role &&
      previousContent === normalizedContent
    ) {
      return;
    }

    deduped.push(message);
  });

  return deduped;
}

function compactLongTextForApiPrompt(text: string, limit: number) {
  const sentences = text
    .split(/(?<=[。！？!?])|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const head = sentences.slice(0, 5).join('\n');
  const tail = sentences.slice(-5).join('\n');
  const middle = sentences
    .slice(5, -5)
    .filter((sentence) =>
      /困|悩|不安|怒|怖|嫌|したい|ほしい|必要|大事|仕事|家族|人間関係|お金|SNS|講座|気づき/.test(
        sentence
      )
    )
    .slice(0, 8)
    .join('\n');

  const compacted = [
    '（長文入力のため、AI処理用に要点を圧縮しています。ユーザーの原文は履歴に保存されています。）',
    head ? `冒頭:\n${head}` : '',
    middle ? `中盤の主な要点:\n${middle}` : '',
    tail ? `末尾:\n${tail}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (compacted.length <= limit) return compacted;

  const half = Math.floor((limit - 80) / 2);
  return [
    '（長文入力のため、AI処理用に冒頭と末尾を中心に圧縮しています。ユーザーの原文は履歴に保存されています。）',
    text.slice(0, half),
    '...',
    text.slice(-half),
  ].join('\n');
}

function getUsage(response: {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}): CoachingUsage {
  return {
    prompt_tokens: response.usageMetadata?.promptTokenCount,
    completion_tokens: response.usageMetadata?.candidatesTokenCount,
    cached_tokens: response.usageMetadata?.cachedContentTokenCount,
    thoughts_tokens: response.usageMetadata?.thoughtsTokenCount,
    total_tokens: response.usageMetadata?.totalTokenCount,
  };
}

function trimToNaturalContinuationBoundary(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  if (endsAtNaturalBoundary(trimmed) && !hasDanglingMarkdown(trimmed)) {
    return trimmed;
  }

  const boundaryIndex = findLastNaturalBoundary(trimmed);
  if (boundaryIndex >= 80) {
    return cleanupTrailingMarkdown(trimmed.slice(0, boundaryIndex + 1));
  }

  const paragraphIndex = trimmed.lastIndexOf('\n\n');
  if (paragraphIndex >= 80) {
    return cleanupTrailingMarkdown(trimmed.slice(0, paragraphIndex));
  }

  return cleanupTrailingMarkdown(trimmed);
}

function endsAtNaturalBoundary(text: string) {
  return /[。！？!?）)]$/.test(text);
}

function findLastNaturalBoundary(text: string) {
  const boundaryChars = ['。', '！', '？', '!', '?'];
  return Math.max(...boundaryChars.map((char) => text.lastIndexOf(char)));
}

function hasDanglingMarkdown(text: string) {
  const boldMarkerCount = (text.match(/\*\*/g) || []).length;
  return boldMarkerCount % 2 === 1;
}

function cleanupTrailingMarkdown(text: string) {
  return text
    .replace(/\s+\*\*[^*\n]*$/g, '')
    .replace(/\*\*$/g, '')
    .replace(/[#*_`「『（(、,，:：-]+$/g, '')
    .trim();
}

function getFinishReason(response: {
  candidates?: Array<{ finishReason?: string }>;
}) {
  return response.candidates?.find((candidate) => candidate.finishReason)
    ?.finishReason;
}

export function classifyGeminiCompletion(finishReason?: string) {
  return finishReason === 'STOP'
    ? ('complete' as const)
    : ('partial' as const);
}

// The two boundaries answered before any model call: a customer in danger gets
// the fixed safety guidance, and a request to reveal the internal instructions
// gets a fixed refusal. Nothing else is answered locally.
function buildImmediateCoachingResponse(text: string) {
  const urgentSafetyResponse = buildUrgentSafetyResponse(text);
  if (urgentSafetyResponse) {
    return {
      text: urgentSafetyResponse,
      modelName: 'local-safety',
      finishReason: 'LOCAL_SAFETY_RESPONSE',
    };
  }
  if (requestsInternalPromptDisclosure(text)) {
    return {
      text: INTERNAL_PROMPT_GUARD_RESPONSE,
      modelName: 'local-guard',
      finishReason: 'LOCAL_PROMPT_GUARD',
    };
  }
  return null;
}

function getGeminiTimeoutMs(isImageRequest: boolean) {
  return isImageRequest
    ? GEMINI_IMAGE_TIMEOUT_MS
    : getCoachingTextModelConfig().timeoutMs;
}

export function containsProtectedInternalContent(text: string) {
  return /ACTIコーチングAI指示書|#{1,3}\s*セクション\s*[1-9]|3つのステップ[：:]\s*共感|変装検出ルール|クライアントに関する非表示の参考情報|【内部(?:応答形式|会話継続指示)】|診断コード\s*[:：]\s*[SMP][VMG][AME]-[1-6]|(?:システム|system)\s*プロンプト.{0,24}(?:全文|以下|内容|指示)/i.test(
    text
  );
}

export function containsInternalCoachingContextExposure(text: string) {
  return /以下は過去の会話の保存済み要約です|前回までの保存済み要約|ACTI_SESSION_MEMORY(?:_V\d+)?|保存済みの事実と経緯を背景として保持|直近のやり取りを最優先しつつ[、,]?流れを失わないための文脈|以下はこれまでの会話の背景です。これは新しい依頼ではありません|承知しました。背景として踏まえ[、,]?直近の会話を優先/i.test(
    text
  );
}

async function tryExternalProviderFallback(params: {
  systemPrompt: string;
  historyMessages: CoachingChatMessage[];
  lastUserParts: GeminiPart[];
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const modelInput = params.lastUserParts
    .map((part) => ('text' in part ? part.text : ''))
    .join('\n')
    .trim();
  if (!modelInput) return null;
  const images = params.lastUserParts
    .filter((part): part is GeminiImagePart => 'inlineData' in part)
    .map((part) => part.inlineData);

  const isFactualImageRequest =
    images.length > 0 &&
    requestsFactualShortAnswer(stripInternalResponseStyleHint(modelInput));
  const fallbackHistory: CoachingChatMessage[] = (
    isFactualImageRequest ? [] : params.historyMessages
  ).map((message) => ({
    role: message.role,
    content: stripAttachmentMarkdown(message.content).trim(),
  }));
  const messages: CoachingChatMessage[] = [
    ...fallbackHistory.filter((message) => message.content),
    { role: 'user' as const, content: modelInput },
  ];
  const candidates = [
    process.env.OPENAI_API_KEY
      ? {
          provider: 'openai' as const,
          model: process.env.COACHING_FALLBACK_OPENAI_MODEL || 'gpt-5.6-luna',
        }
      : null,
    process.env.ANTHROPIC_API_KEY
      ? {
          provider: 'anthropic' as const,
          model:
            process.env.COACHING_FALLBACK_ANTHROPIC_MODEL || 'claude-sonnet-5',
        }
      : null,
  ].filter(
    (
      candidate
    ): candidate is {
      provider: 'openai' | 'anthropic';
      model: string;
    } => Boolean(candidate)
  );
  if (candidates.length === 0) return null;
  if (params.signal?.aborted) return null;

  const { generateCoachingProviderCandidate } = await import(
    '@/lib/coaching-provider-candidates'
  );
  const controllers = candidates.map(() => new AbortController());
  const abortCandidates = () => {
    controllers.forEach((controller) => controller.abort());
  };
  params.signal?.addEventListener('abort', abortCandidates, { once: true });
  let winnerSelected = false;
  const attempts = candidates.map(async (candidate, index) => {
    try {
      const result = await generateCoachingProviderCandidate({
        ...candidate,
        systemPrompt: params.systemPrompt,
        messages,
        images,
        timeoutMs:
          params.timeoutMs ||
          (images.length > 0
            ? EXTERNAL_IMAGE_FALLBACK_TIMEOUT_MS
            : EXTERNAL_FALLBACK_TIMEOUT_MS),
        signal: controllers[index].signal,
      });
      if (result.complete && result.rawText.trim()) {
        return { ...result, ...candidate };
      }
      console.warn(
        JSON.stringify({
          event: 'coaching_fallback_candidate_incomplete',
          ...candidate,
          finishReason: result.finishReason,
          outputChars: result.rawText.length,
        })
      );
      throw new Error('COACHING_FALLBACK_INCOMPLETE');
    } catch (error) {
      if (
        !winnerSelected &&
        !controllers[index].signal.aborted &&
        getErrorMessage(error) !== 'COACHING_FALLBACK_INCOMPLETE'
      ) {
        console.warn(
          JSON.stringify({
            event: 'coaching_fallback_candidate_failed',
            ...candidate,
            error: getErrorMessage(error).slice(0, 500),
          })
        );
      }
      throw error;
    }
  });

  try {
    const winner = await Promise.any(attempts);
    winnerSelected = true;
    return winner;
  } catch {
    return null;
  } finally {
    winnerSelected = true;
    params.signal?.removeEventListener('abort', abortCandidates);
    abortCandidates();
  }
}

function extractTextFromParts(parts: GeminiPart[]) {
  const combined = parts
    .map((part) => ('text' in part ? part.text : ''))
    .join('\n')
    .trim();

  return stripInternalResponseStyleHint(combined);
}

export function stripInternalResponseStyleHint(text: string) {
  return text
    .replace(
      /\n+【内部(?:応答形式|会話継続指示)】[\s\S]*$/u,
      ''
    )
    .trim();
}

export function assessCoachingResponseQuality(
  text: string
): CoachingQualityAssessment {
  const issues: CoachingQualityIssue[] = [];
  if (
    containsInternalCoachingContextExposure(text) ||
    containsProtectedInternalContent(text)
  ) {
    issues.push('internal_context_exposure');
  }
  if (hasUnsafeHighImpactAdvice(text)) {
    issues.push('unsafe_high_impact_advice');
  }
  return { issues };
}

function hasUnsafeHighImpactAdvice(text: string) {
  const unilateralHighImpactChange =
    /強制的|一切(?:やめ|払わ)|一切[^。！？?\n]{0,24}(?:手をつけず|放置)|すべてストップ|支払いを止め|補填(?:するの)?を(?:やめ|止め)|生活費[^。！？?\n]{0,40}(?:全て|すべて)[^。！？?\n]{0,24}(?:止め|やめ|ストップ)|管理会社[^。！？?\n]{0,100}変更手続きを進め|(?:家賃|引き落とし)[^。！？?\n]{0,100}(?:口座|名義)[^。！？?\n]{0,60}(?:変更|移す)|(?:口座|名義)[^。！？?\n]{0,80}(?:夫|妻|相手)[^。！？?\n]{0,40}(?:変更|移す)|(?:夫|妻|相手|パートナー|ご主人|奥様)(?:の)?口座[^。！？?\n]{0,120}(?:家賃|引き落とし|引落)[^。！？?\n]{0,120}(?:手続き|設定)[^。！？?\n]{0,32}(?:変更|切り替|変え)/.test(
      text
    );
  const spendsSharedOrOtherPersonsFunds =
    /(?:(?:夫|妻|相手)の小遣い|共通(?:の)?(?:口座|生活費|資金|家計)|家計から)[^。！？?\n]{0,80}(?:支払|使|充て|負担|捻出|出)|(?:費用|料金)[^。！？?\n]{0,60}(?:(?:夫|妻|相手)の小遣い|共通(?:の)?(?:口座|生活費|資金|家計)|家計から)[^。！？?\n]{0,32}(?:支払|使|充て|負担|捻出|出)/.test(
      text
    );
  const confirmsAgreement =
    /合意|同意|了承|話し合って決め|相談して決め|確認してから/.test(
      text
    );

  return (
    unilateralHighImpactChange ||
    (spendsSharedOrOtherPersonsFunds && !confirmsAgreement)
  );
}

type CoachingQualityResolution = {
  text: string;
  usage: CoachingUsage;
  modelName: string;
  provider?: string;
  initialIssues: CoachingQualityIssue[];
  finalIssues: CoachingQualityIssue[];
  qualitySafetyHold: boolean;
  chargeable: boolean;
};

function buildImmediateResolution(response: {
  text: string;
  modelName: string;
}): CoachingQualityResolution {
  return {
    text: response.text,
    usage: {},
    modelName: response.modelName,
    provider: 'local',
    initialIssues: [],
    finalIssues: [],
    qualitySafetyHold: false,
    chargeable: false,
  };
}

function buildGenerationUnavailableResolution(): CoachingQualityResolution {
  return {
    text: GENERATION_UNAVAILABLE_NOTICE,
    usage: {},
    modelName: 'local-fallback',
    provider: 'local',
    initialIssues: [],
    finalIssues: [],
    qualitySafetyHold: false,
    chargeable: false,
  };
}

function toGenerationResult(resolution: CoachingQualityResolution) {
  return {
    text: resolution.text,
    usage: resolution.usage,
    modelName: resolution.modelName,
    provider: resolution.provider,
    qualityInitialIssues: resolution.initialIssues,
    qualityFinalIssues: resolution.finalIssues,
    qualitySafetyHold: resolution.qualitySafetyHold,
    chargeable: resolution.chargeable,
  };
}

function readGeminiResponseText(response: { text: () => string }) {
  try {
    return response.text();
  } catch {
    return '';
  }
}

export function minimallySanitizeCoachingOutput(text: string) {
  return cleanupTrailingMarkdown(
    text
      .replace(/^```(?:markdown|text)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*/g, '')
  );
}

// The only post-generation gate. Model text is delivered as written, after
// minimal markdown cleanup, unless it crosses a customer-safety boundary:
// exposure of internal prompt/context, or unsafe high-impact advice.
function applyCoachingSafetyBoundaries(params: {
  rawText: string;
  usage: CoachingUsage;
  modelName: string;
  provider?: string;
}): CoachingQualityResolution {
  const deliveryText = minimallySanitizeCoachingOutput(params.rawText);
  const observedIssues = [
    ...new Set([
      ...assessCoachingResponseQuality(params.rawText).issues,
      ...assessCoachingResponseQuality(deliveryText).issues,
    ]),
  ];
  const safetyReplacement = observedIssues.includes(
    'internal_context_exposure'
  )
    ? INTERNAL_PROMPT_GUARD_RESPONSE
    : observedIssues.includes('unsafe_high_impact_advice')
      ? UNSAFE_HIGH_IMPACT_ADVICE_NOTICE
      : '';
  if (safetyReplacement) {
    return {
      text: safetyReplacement,
      usage: params.usage,
      modelName: 'local-output-safety-fallback',
      provider: 'local',
      initialIssues: observedIssues,
      finalIssues: [],
      qualitySafetyHold: false,
      chargeable: false,
    };
  }
  return {
    text: deliveryText,
    usage: params.usage,
    modelName: params.modelName,
    provider: params.provider,
    initialIssues: observedIssues,
    finalIssues: [],
    qualitySafetyHold: false,
    chargeable: true,
  };
}

export function buildUrgentSafetyResponse(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const mentionsSelfHarm = [
    /死にたい|死んで(?:しまい)?たい|死んだ(?:ほう|方)が(?:まし|いい)/,
    /消えたい|生きていたくない|生きるのをやめたい|もう生きられない/,
    /自殺(?:したい|しよう|する|を考|を図)|命を(?:絶|断)/,
    /自分(?:自身)?を傷つけ|自傷|リストカット/,
    /飛び降り|首を吊|大量(?:の)?薬|薬を大量|大量服薬|オーバードーズ|\bOD(?:したい|する|しよう)\b/i,
    /\bsuicid(?:e|al)\b|kill myself|hurt myself|self[- ]harm/i,
  ].some((pattern) => pattern.test(normalized));
  if (!mentionsSelfHarm) return null;

  return [
    '今はコーチングより、安全の確保を優先してください。あなた自身または身近な方が今すぐ自分を傷つける可能性がある場合は、一人にならず、危険な物や場所から離れ、近くの人に「今、一人にしないで」と伝えてください。日本国内なら119へ連絡してください。国外にいる場合は、現地の緊急番号へ連絡してください。',
    '今すぐの危険がなくても、いのちSOS（0120-061-338）または、よりそいホットライン（0120-279-338）へ電話してください。どちらも24時間・無料です。',
    'このBotだけで抱え込まず、今すぐ連絡できる人へ電話できますか？',
  ].join('\n\n');
}

function requestsSingleAnswerFormat(text: string) {
  const withoutRepeatedQuestionComplaint = text
    .replace(/同じ質問(?:は|を)?(?:しない|しないで|不要)/g, '')
    .replace(/(?:一つ|ひとつ|1つ)(?:隣|前|後ろ|横|上|下|先)/g, '');
  return /(?:(?:一つ|ひとつ|1つ)(?:だけ)?.{0,24}(?:教|提案|答|挙|示|伝|お願)|(?:教|提案|答|挙|示|伝|お願).{0,24}(?:一つ|ひとつ|1つ)(?:だけ)?|一言(?:だけ|で)|最初の一言|質問(?:は|を)?(?:なし|不要|しない)|短く(?:答|教|返))/.test(
    withoutRepeatedQuestionComplaint
  );
}

function requestsDirectWording(text: string) {
  if (
    /(?:名前|色|枚数|個数|数|種類|日時|日付|時刻|場所|金額|価格|コード|タイプ)[^。！？\n]{0,28}一言で(?:教えて|答えて)/.test(
      text
    )
  ) {
    return false;
  }
  const potentialWordingRequest = /(?:どんな|どういう)(?:言葉|一言)で(?:返せ|伝えられ|言え)ますか[。？！!?\s]*$/.test(
    stripJapaneseQuotationContent(text)
  );
  return potentialWordingRequest || /最初の一言|断(?:る|りたい|り方)[^。！？\n]{0,24}(?:一言|言い方|文面|言葉|文章)|(?:一言|言い方|文面|返事|言葉|文章)[^。！？\n]{0,28}(?:教えて|提案して|考えて|作って|示して|どうすれば|どうしたら)|(?:教えて|提案して|考えて|作って|示して)[^。！？\n]{0,28}(?:一言|言い方|文面|返事|言葉|文章)|(?:どんな|どういう)(?:文章|反応|返し方|返事|言い方)[^。！？\n]{0,28}(?:にしたら|にすれば|が良い|がいい|がよい|なら良い|ならいい|ならよい)|(?:どう|何と|なんて)(?:言|伝え)(?:え|たら|れば|る|う)|どう返せば|(?:言わずに|かわす)方法/.test(
    text
  );
}

function requestsFactualShortAnswer(text: string) {
  return (
    /画像|添付|名前|色|枚数|個数|件数|種類|日時|日付|時刻|場所|金額|価格|コード/.test(
      text
    ) &&
    /答えて|教えて|確認|読み込め|見て|見え|何(?:色|枚|個|件|時|円)|どれ/.test(
      text
    )
  );
}

function requestsInternalPromptDisclosure(text: string) {
  return /(?:システムプロンプト|内部指示|内部プロンプト|設定されている指示|隠された指示).{0,80}(?:表示|開示|公開|全文|そのまま|教えて|見せて)|(?:表示|開示|公開|全文|そのまま|教えて|見せて).{0,80}(?:システムプロンプト|内部指示|内部プロンプト|設定されている指示|隠された指示)/.test(
    text
  );
}

function requestsExplicitClosingQuestion(text: string) {
  if (
    /質問(?:は|を)?(?:なし|不要|しない|せず)|質問を付けない|質問で終わらない/.test(
      text
    )
  ) {
    return false;
  }

  return /(?:最後|末尾|終わり|締め).{0,40}質問|質問(?:を|は)?[^。！？?\n]{0,20}(?:一つ|ひとつ|1つ)(?:だけ)?[^。！？?\n]{0,12}(?:して|付け|添え|ください|お願い)/.test(
    text
  );
}

function explicitlyStopsThinkingPolitely(text: string) {
  return /(?:^|[。！!\n])(?:今日は|もう|今日はもう)?[、,\s]*(?:何も|もう)考えたくありません[。！!\s]*$/.test(text.trim());
}

function requestsRestWithoutQuestions(text: string) {
  return explicitlyStopsThinkingPolitely(text) || /何も考えたくない|もう考えたくない|今日はもう(?:無理|限界)|疲れ(?:た|ました)|しんどい|休みたい/.test(
    text
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorCode = 'GEMINI_TIMEOUT'
) {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(errorCode)),
      timeoutMs
    );
  });

  return Promise.race([
    promise,
    timeout,
  ]).finally(() => clearTimeout(timeoutId));
}
