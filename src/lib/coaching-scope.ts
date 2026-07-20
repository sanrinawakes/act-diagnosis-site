import type { CoachingChatMessage } from '@/lib/coaching-gemini';

export const COACHING_LONG_MESSAGE_CHARS = 2000;

export const COACHING_SCOPE_GUIDANCE =
  'ACTIは、ACT診断結果を使った自己理解や、感情・行動・人間関係・仕事についての本人の相談専用です。一般的な文章添削、広告作成、翻訳、調査、プログラム作成、画像生成には対応していません。今の依頼について、あなた自身が何に悩み、どう判断し、どう行動するかを整理する相談であれば、その形でお手伝いできます。';

export type CoachingScopeDecision = 'allowed' | 'blocked';

export type CoachingScopeCategory =
  | 'coaching'
  | 'conversation_followup'
  | 'writing_editing'
  | 'marketing_content'
  | 'translation'
  | 'external_research'
  | 'image_generation'
  | 'programming'
  | 'ambiguous';

export type CoachingScopeResult = {
  decision: CoachingScopeDecision;
  category: CoachingScopeCategory;
  matchedRule: string;
  messageChars: number;
  totalRequestChars: number;
  lineCount: number;
  isLongMessage: boolean;
  attachmentCount: number;
};

type ScopeClassification = Pick<
  CoachingScopeResult,
  'decision' | 'category' | 'matchedRule'
>;

const MARKETING_OBJECT =
  /(?:広告|宣伝|販促|集客|\blp\b|ランディングページ|セールス(?:レター|ページ)|販売ページ|キャッチコピー|コピーライティング|sns(?:投稿)?|instagram|インスタ(?:グラム)?(?:投稿)?|facebook(?:投稿)?|twitter|x投稿|ブログ|メルマガ|youtube(?:動画)?(?:台本)?|動画台本|商品説明|告知文|プレスリリース|seo|ハッシュタグ|バナー|チラシ|営業資料)/i;
const CONTENT_CREATION_ACTION =
  /(?:作(?:成|って|る)|書いて|考えて|添削|校正|推敲|リライト|書き直|修正して|改善して|要約して|構成して|案を(?:出|作)|生成して|魅力的にして|お願い(?:します)?)/i;
const WRITING_OBJECT =
  /(?:文章|原稿|作文|レポート|論文|スピーチ|乾杯(?:の)?挨拶|挨拶文|祝辞|プロフィール文|自己紹介文|メール(?:文)?|メッセージ文|台本|記事)/i;
const TRANSLATION_INTENT =
  /(?:翻訳して|英訳して|和訳して|中国語に(?:訳|翻訳|して)|韓国語に(?:訳|翻訳|して)|日本語に(?:訳|翻訳|して)|英語に(?:訳|翻訳|して)|(?:英語|日本語|中国語|韓国語)へ(?:訳|翻訳))/i;
const IMAGE_GENERATION_INTENT =
  /(?:(?:画像|写真|イラスト|絵|ロゴ|アイコン|サムネイル|バナー).{0,18}(?:生成|作って|作成|作れ|描いて|デザインして)|(?:生成|作成).{0,12}(?:画像|写真|イラスト|絵|ロゴ))/i;
const PROGRAMMING_OBJECT =
  /(?:プログラム|ソースコード|コード|sql|html|css|javascript|typescript|python|php|java|アプリ|ウェブサイト|webサイト|スクリプト|正規表現)/i;
const PROGRAMMING_ACTION =
  /(?:書いて|作って|作成して|実装して|修正して|直して|デバッグして|変換して|生成して|書き方を教えて)/i;
const RESEARCH_INTENT =
  /(?:調べて|検索して|リサーチして|情報を集めて|出典を探して|比較して|市場調査|競合分析|参考文献|最新情報)/i;
const EXTERNAL_RESEARCH_OBJECT =
  /(?:web|ウェブ|ネット|google|ニュース|市場|競合|統計|論文|文献|商品|サービス|企業|会社|店舗|法律|制度|価格|料金|口コミ|評判|旅行|ホテル|病院|学校|資格|補助金|助成金|ツール)/i;
const COACHING_CONTEXT =
  /(?:acti|act診断|診断結果|タイプコード|意識レベル|自己理解|感情|気持ち|本音|悩|不安|恐怖|怖|つら|辛|悲し|怒|焦|葛藤|迷|行動パターン|人間関係|家族関係|夫婦関係|職場関係|キャリア|転職|仕事の悩み|目標|習慣|自己肯定|自信|成長|相談|内面|自分と向き合)/i;
const PERSONAL_RELATIONSHIP =
  /(?:夫|妻|旦那|配偶者|家族|母|父|両親|親|子ども|子供|息子|娘|兄|弟|姉|妹|友人|友達|上司|部下|同僚|パートナー|彼氏|彼女|恋人)/i;
const PERSONAL_COMMUNICATION =
  /(?:line|メール|メッセージ|手紙|返信|返事|伝え方|言い方|話し方|会話|謝り|断り|お願いする|気持ちを伝え)/i;
const PERSONAL_EMOTION =
  /(?:気持ち|本音|悩み|不安|怖|つら|辛|悲し|怒り|傷つ|迷い|葛藤|関係|仲直り|謝り|断りたい)/i;
const CONTINUATION_REQUEST =
  /(?:続き|もう一度|もう一回|もっと|もう少し|短く|長く|詳しく|具体的|魅力的|やわらかく|強め|女性向け|男性向け|初心者向け|別案|別の案|別パターン|ほかにも|他にも|修正して|直して|書き直して|変えて|同じように|それでお願い|これでお願い|\d+案)/i;

export function classifyCoachingScope(params: {
  messages: CoachingChatMessage[];
  attachmentCount?: number;
}): CoachingScopeResult {
  const messages = params.messages;
  const latest = messages.at(-1)?.content || '';
  const attachmentCount = Math.max(0, params.attachmentCount || 0);
  const totalRequestChars = messages.reduce(
    (total, message) => total + message.content.length,
    0
  );
  const messageChars = latest.length;
  const lineCount = latest ? latest.split(/\r?\n/).length : 0;
  const metadata = {
    messageChars,
    totalRequestChars,
    lineCount,
    isLongMessage: messageChars >= COACHING_LONG_MESSAGE_CHARS,
    attachmentCount,
  };

  const normalizedLatest = normalizeForScope(latest);
  const direct = classifyDirectRequest(normalizedLatest);
  if (direct) return { ...direct, ...metadata };

  if (
    COACHING_CONTEXT.test(normalizedLatest) ||
    isPersonalCommunicationRequest(normalizedLatest) ||
    attachmentCount > 0
  ) {
    return {
      decision: 'allowed',
      category: 'coaching',
      matchedRule:
        attachmentCount > 0
          ? 'coaching_with_attachment'
          : 'explicit_coaching_context',
      ...metadata,
    };
  }

  if (isContinuationRequest(normalizedLatest)) {
    const previousUserMessages = messages
      .slice(0, -1)
      .filter((message) => message.role === 'user')
      .slice(-3)
      .reverse();

    for (const previousMessage of previousUserMessages) {
      const inherited = classifyDirectRequest(
        normalizeForScope(previousMessage.content)
      );
      if (inherited?.decision === 'blocked') {
        return {
          decision: 'blocked',
          category: inherited.category,
          matchedRule: `continued_${inherited.matchedRule}`,
          ...metadata,
        };
      }
    }

    return {
      decision: 'allowed',
      category: 'conversation_followup',
      matchedRule: 'short_conversation_followup',
      ...metadata,
    };
  }

  return {
    decision: 'allowed',
    category: 'ambiguous',
    matchedRule: 'ambiguous_request_allowed',
    ...metadata,
  };
}

function classifyDirectRequest(text: string): ScopeClassification | null {
  if (!text) return null;

  if (IMAGE_GENERATION_INTENT.test(text)) {
    return blocked('image_generation', 'image_generation_request');
  }

  if (TRANSLATION_INTENT.test(text) && !isPersonalCommunicationRequest(text)) {
    return blocked('translation', 'general_translation_request');
  }

  if (PROGRAMMING_OBJECT.test(text) && PROGRAMMING_ACTION.test(text)) {
    return blocked('programming', 'programming_request');
  }

  if (MARKETING_OBJECT.test(text) && CONTENT_CREATION_ACTION.test(text)) {
    return blocked('marketing_content', 'marketing_content_request');
  }

  if (
    RESEARCH_INTENT.test(text) &&
    (EXTERNAL_RESEARCH_OBJECT.test(text) || !COACHING_CONTEXT.test(text))
  ) {
    return blocked('external_research', 'external_research_request');
  }

  if (
    WRITING_OBJECT.test(text) &&
    CONTENT_CREATION_ACTION.test(text) &&
    !isPersonalCommunicationRequest(text)
  ) {
    return blocked('writing_editing', 'general_writing_request');
  }

  return null;
}

function blocked(
  category: Exclude<CoachingScopeCategory, 'coaching' | 'conversation_followup' | 'ambiguous'>,
  matchedRule: string
): ScopeClassification {
  return { decision: 'blocked', category, matchedRule };
}

function isPersonalCommunicationRequest(text: string) {
  return (
    PERSONAL_RELATIONSHIP.test(text) &&
    (PERSONAL_COMMUNICATION.test(text) || PERSONAL_EMOTION.test(text)) &&
    !MARKETING_OBJECT.test(text)
  );
}

function isContinuationRequest(text: string) {
  return text.length <= 120 && CONTINUATION_REQUEST.test(text);
}

function normalizeForScope(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\r\n/g, '\n')
    .trim();
}

export function createScopeBlockedStream(params: {
  result: CoachingScopeResult;
  remaining: number;
  limit: number;
}) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({
            type: 'chunk',
            text: COACHING_SCOPE_GUIDANCE,
            verified: true,
          })}\n`
        )
      );
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({
            type: 'done',
            modelName: 'scope-guard',
            completionStatus: 'complete',
            finalizationStatus: 'complete',
            finishReason: 'SCOPE_BLOCKED',
            message: COACHING_SCOPE_GUIDANCE,
            usage: {},
            remaining: params.remaining,
            limit: params.limit,
            scopeDecision: params.result.decision,
            scopeCategory: params.result.category,
          })}\n`
        )
      );
      controller.close();
    },
  });
}
