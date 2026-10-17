import { stripJapaneseQuotationContent, splitOutsideJapaneseQuotations } from './coaching-quotation-language.mjs';
import { currentTopicUserTexts } from './coaching-emotion-language.mjs';

// A formatting-only follow-up does not replace a USER's action date. Accept
// one opaque alphanumeric tracking identifier, not an arbitrary leading clause.
function withoutOpaqueTrackingIdentifier(value) {
  return value.trim().replace(/^(?=[A-Za-z0-9_-]{8,100}。)(?=[^。]*[0-9])(?=[^。]*[-_])[A-Za-z][A-Za-z0-9_-]*。\s*/u, '');
}
function shorteningOnlyRequest(value) {
  if (typeof value !== 'string') return false;
  const text = withoutOpaqueTrackingIdentifier(value);
  return /^(?:(?:前|直前|先ほど)の(?:返答|回答|答え)を)?(?:(?:もう少し|もうちょっと|もっと)短く(?:して|答えて|教えて|返して)|短く(?:答えて|教えて|返して|して)|簡潔に(?:答えて|教えて|返して|して)|一文で(?:答えて|教えて|返して))(?:ください|下さい|ほしいです|ほしい)?[。！!\s]*$/u.test(text);
}

/** Resolve only the observed tomorrow-action/formatting continuation. */
export function resolveShorteningActionTimeRequest(lastUserText, userTexts = []) {
  if (!shorteningOnlyRequest(lastUserText)) return lastUserText;
  const users = currentTopicUserTexts([...userTexts, lastUserText]);
  for (const source of [...users].reverse()) {
    if (shorteningOnlyRequest(source)) continue;
    // Stop at the latest substantive USER turn. Older requests, AI text and
    // summaries cannot restore a superseded date. Abstain on attributed,
    // hypothetical, quoted, cancelled or corrected requests.
    if (/[「」『』"'？?]|もし|仮に|ではなく|じゃなく|撤回|取り消|と(?:言われ|言って|聞い|書かれ|提案され)|とのこと|そうです|(?:言って|頼んで|求めて|依頼して)(?:いません|いない)|明日[^。！？\n]{0,25}(?:やめ|しない|しません|不要|無理)/u.test(source)) return lastUserText;
    const request = withoutOpaqueTrackingIdentifier(source);
    return /^(?:私は[、,\s]*)?明日[^。！？\n]{0,100}(?:教えて|提案して|答えて|示して|挙げて)(?:ください|下さい|ほしいです|ほしい)?[。！!\s]*$/u.test(request) &&
      /行動|一歩|何をすれば|どうすれば|できること|すること|やること|始める/u.test(source) &&
      !/文案|文面|せりふ|セリフ|台詞|言い方|伝える(?:言葉|一言)|最初の一言/u.test(source)
      ? source : lastUserText;
  }
  return lastUserText;
}

/** A shortened action must keep its active day, including an explicit morning. */
export function containsShorteningActionTimeMismatch(text, lastUserText, userTexts = []) {
  const request = resolveShorteningActionTimeRequest(lastUserText, userTexts);
  if (request === lastUserText) return false;
  const action = stripJapaneseQuotationContent(text, true);
  return !/明日/u.test(action) ||
    (/明日の朝/u.test(request) && !/明日の朝/u.test(action)) ||
    /今[、,]|今すぐ|今から|今夜|(?:^|[、,。！？\n])\s*(?:今日|本日)[、,]|(?:今日|本日)(?:中|のうち)|明日(?:ではなく|じゃなく)(?:今日|本日)/u.test(action) ||
    containsAmbiguousFutureActionDayReference(text, request, userTexts);
}

// Bounded current report: it states a colleague's document plan, not the
// user's plan or a request to change that colleague's behavior.
export function isThirdPartyPurposePlanReport(text) {
  return typeof text === 'string' && /^同僚は一枚目に利用目的を書く予定です[。！!]*$/u.test(text.trim());
}

/** A pending refusal reply or a document-plan report is not a change request. */
export function containsMisfocusedFriendDeclineQuestion(text, currentUserTexts = []) {
  let ownDeclineReplyIsCurrentGoal = false;
  for (const value of currentUserTexts) {
    if (typeof value !== 'string') continue;
    const ownWords = stripJapaneseQuotationContent(value, true)
      .replace(/"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
    const ownSubjectBefore = index => {
      const prefix = ownWords.slice(0, index).split(/[。！？?\n]/u).at(-1) || '';
      const subject = [...prefix.matchAll(/([^\s、,。！？?]{1,24}?)(?<!で)(?:は|が)/gu)].at(-1)?.[1];
      return !subject || /^(?:私|私自身|自分|自分自身|自身|今|今日|現在|今回)$/u.test(subject);
    };
    const friend = /(?:友人|友達)(?:に|の(?:誘い|予定))/u.exec(ownWords);
    // Only the bounded current USER task supplies the goal. A quoted example,
    // somebody else's reported task, or a hypothetical does not establish it.
    if (!/[？?]|もし|仮に|例文|例として|(?:と|って)(?:AI|アシスタント|ChatGPT)?(?:に)?(?:言われ|聞かれ|書かれ|提案され)/u.test(ownWords) &&
        friend && ownSubjectBefore(friend.index) &&
        /断りたい|断る返事|断りの返事/u.test(ownWords) &&
        /(?:返事|返信)[^。！？?\n]{0,32}(?:先延ばし|遅らせ|ためら|送れなく)/u.test(ownWords) &&
        !/断りたい(?:わけ|という意味)では(?:ない|ありません)/u.test(ownWords)) {
      ownDeclineReplyIsCurrentGoal = true;
    }
    // A later direct USER goal can legitimately shift to the friend's action.
    // Keep a negative/report/quoted occurrence from becoming that permission.
    const otherGoal = /(?:友人|友達|相手)に[^。！？?\n]{0,24}変えてほしい行動を(?:考えたい|話したい|相談したい)(?:です)?[。！!\s]*$|(?:友人|友達|相手)(?:に(?:は)?|の行動を)[^。！？?\n]{0,32}変えてほしい(?:です)?[。！!\s]*$/u.exec(ownWords);
    if (otherGoal && ownSubjectBefore(otherGoal.index) && !/[？?]|もし|仮に/u.test(ownWords)) {
      ownDeclineReplyIsCurrentGoal = false;
    }
    if (friend && ownSubjectBefore(friend.index) &&
        /断りたい(?:わけ|という意味)では(?:ない|ありません)/u.test(ownWords)) {
      ownDeclineReplyIsCurrentGoal = false;
    }
  }
  if (!ownDeclineReplyIsCurrentGoal &&
      !isThirdPartyPurposePlanReport(currentUserTexts.at(-1))) return false;
  const question = /(?:その)?(?:相手|友人|友達)に[、,\s]*(?:まず)?(?:どの行動|何)を変えてほしい(?:ですか|でしょうか|と思いますか)[？?]/u;
  return splitOutsideJapaneseQuotations(text).some(segment => {
    const outside = stripJapaneseQuotationContent(segment, true)
      .replace(/"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
    // A standalone new quoted question is still the assistant's question.
    // A faithful report has words outside the quote and is inspected there.
    const standalone = /^[。！!？?\s]*$/u.test(outside);
    return question.test(standalone ? segment : outside);
  });
}

/** A start verb with only an unspecified task restates the requested action. */
export function containsCircularSingleAction(text) {
  const unquoted = text.replace(/「[^」]*」|『[^』]*』/gu, '').replace(/\s+/gu, '');
  return /(?:最初に(?:行う|する|取り組む)|最初の)(?:作業|タスク|行動)(?:に|を)(?:(?:一|1|ひと)つだけ)?(?:着手して|取り組んで|始めて|開始して|進めて)(?:みて)?ください[。！!]*$/u.test(unquoted);
}

function requestsMultipleCoachingActions(lastUserText) {
  const ownRequest = stripJapaneseQuotationContent(lastUserText, true).replace(/"[^"]*"|'[^']*'/gu, '');
  const single = /一つ|ひとつ|1つ|一動作|一問|一言だけ|質問なし/u.test(ownRequest);
  let multipleRequested = false;
  for (const clause of ownRequest.split(/(?<=[。！？?\n])|[、,]|しかし|ただし/u)) {
    if (!/複数|いくつか|両方|二つ|2つ|手順|順番|ステップ/u.test(clause)) continue;
    if (/しない|しません|やめて|不要|いらない|必要(?:は)?ありません|必要ない|禁止|ではなく|(?:頼んで|求めて|お願いして|言って|依頼して)(?:いません|いない)/u.test(clause)) {
      multipleRequested = false;
      continue;
    }
    if (/(?:複数|いくつか|両方|二つ|2つ|手順|順番|ステップ)[^。！？?\n]{0,24}(?:(?:教えて|提案して|説明して|示して|挙げて|答えて)(?:ください|ほしい(?:です)?|もらえますか|もらえませんか)?|(?:を)?お願いします)(?:ね)?[。！!？?\s]*$/u.test(clause)) multipleRequested = true;
  }
  return !single && multipleRequested;
}

/** A conditional follow-up is still a second instructed communication action. */
export function containsChainedCommunicationInstructions(text, lastUserText = '') {
  if (requestsMultipleCoachingActions(lastUserText)) return false;
  // Draft content can itself describe a sequence. Only instructions outside
  // the quoted wording count, including instructions after a closing quote.
  const outside = stripJapaneseQuotationContent(text, true).replace(/"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
  return /(?:伝え(?:し)?|話し|説明し|答え|返事(?:を)?し)(?:てから|た後(?:に|で)?|[、,]\s*(?:その後|続いて|次に))[^。！？?\n]{0,80}(?:(?:尋ね|質問し|確認し)(?:て(?:みて)?ください|ましょう|てみませんか|てはどうでしょうか)|聞(?:いて(?:みて)?ください|きましょう))/u.test(outside);
}

/** Selecting/reviewing/retaining text and then editing it are separate actions. */
export function containsChainedEditingInstructions(text, lastUserText = '') {
  if (requestsMultipleCoachingActions(lastUserText)) return false;
  const outside = stripJapaneseQuotationContent(text, true).replace(/"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
  return /(?:(?:選び|見直し|残し)[、,]|(?:選んで|見直して|残して)(?:みて)?ください[。！!])\s*[^。！？?\n]{0,100}(?:外して|削って|絞って)(?:みて)?ください(?:ね)?(?=[。！!\n]|$)/u.test(outside);
}

/** A new hold/record instruction cannot precede a second suggested operation. */
export function containsChainedPreparationInstructions(text, lastUserText = '') {
  if (requestsMultipleCoachingActions(lastUserText)) return false;
  const outside = stripJapaneseQuotationContent(text, true).replace(/"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
  // These bounded families come from the observed topic-recovery and rent
  // fallbacks. A past action, a quoted report, or two objects of one check do
  // not establish a new preparatory instruction.
  const holdThenCheck = /保留にし(?:[、,]|て(?:から|ください[。！!]))[^。！？?\n]{0,100}(?:確認して|見直して)(?:みて)?ください(?:ね)?(?=[。！!\n]|$)/u;
  const recordThenAct = /(?:記録し|一覧にし|記録にまとめ)(?:[、,]|て(?:から|ください[。！!]))[^。！？?\n]{0,120}(?:書面で[^。！？?\n]{0,40}(?:回答|合意)を求める(?:方法があります|段階です)|(?:確認して|決めて|選んで)(?:みて)?ください)(?:ね)?(?=[。！!\n]|$)/u;
  // Opening a writing/reference artifact and then acting on it are two
  // instructions even when the first verb uses the conjunctive form 開き、.
  // A quoted report or wording to convey remains content. A standalone quoted
  // instruction, or asking to try/execute that instruction, is still an action.
  const openingThenAct = /(?:ノート|メモ帳|手帳|資料|ファイル|ページ)(?:を|は)[^。！？?、,\n]{0,20}開(?:き[、,]|いて(?:から[、,]?|[、,]))[^。！？?\n]{0,100}(?:(?:書き出して|書いて|書き直して|記録して|確認して|見直して|読み返して|読んで|選んで|まとめて)(?:みて)?ください|(?:書き出し|書き|書き直し|記録し|確認し|見直し|読み返し|読み|選び|まとめ)ましょう)(?:ね)?[ \t]*(?=[。！!\n」』"']|$)/u;
  const openingChain = splitOutsideJapaneseQuotations(text.replace(/\r?\n/g, ' ')).some(segment => {
    const outsideSegment = stripJapaneseQuotationContent(segment, true)
      .replace(/"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
    const quoteIsNewOperation = /^\s*(?:例えば[、,]?\s*)?(?:[。！!\s]*|を(?:試して|やってみて|実行して)(?:みて)?ください[。！!\s]*)$/u.test(outsideSegment);
    return openingThenAct.test(quoteIsNewOperation ? segment : outsideSegment);
  });
  return holdThenCheck.test(outside) || recordThenAct.test(outside) || openingChain;
}

// These are concrete premises from the observed fallback failures, rather than
// a general classifier for feelings, actors or every possible task artifact.
const SITUATION_PREMISES = [
  { output: /言葉を出す前に止まっている/u, evidence: /言葉を出す前に止まって|言葉が出ない|話せなく/u },
  { output: /止まっている出来事/u, evidence: /止まって|停滞|動いてくれません/u },
  { output: /次に何を言ってもまた否定される/u, evidence: /何を言っても[^。！？\n]{0,8}否定|また否定される/u },
  { output: /前回のご指摘|どの指摘から直せば/u, evidence: /指摘|修正点|見直す点/u },
];

// Only direct user clauses can supply these bounded situation/task facts.
// Later explicit denial cancels an earlier assertion of the same fact.
/** @param {RegExp | null} [additionalDenial] */
export function hasCurrentUserSituationEvidence(currentUserTexts, expression, additionalDenial = null) {
  let affirmed = false;
  for (const value of currentUserTexts) {
    const ownWords = value.replace(/「[^」]*」|『[^』]*』/gu, '');
    for (const clause of ownWords.split(/(?<=[。！？?\n])|[、,]|しかし|ただし/u)) {
      const mention = expression.exec(clause);
      if (!mention) continue;
      const prefix = clause.slice(0, mention.index);
      const actor = [...prefix.matchAll(/([^\s、。！？?]{1,24}?)(?:は|が)/gu)].at(-1)?.[1];
      const owner = prefix.match(/([^\s、。！？?]{1,24})の$/u)?.[1];
      const self = /^(?:私|私自身|自分|自分自身|自身)$/u;
      if ((actor && !self.test(actor) && !/^(?:今|今日|現在|昨日|前回)$/u.test(actor)) ||
          (owner && !self.test(owner))) continue;
      if (/[？?]|もし|仮に|(?:と|って)(?:AI|言われ|言って|書かれ|提案され)|かもしれ/u.test(clause)) continue;
      const denied = /(?:は|が|も)(?:ありません|ない)|(?:受け|作っ|止まっ|され|し|言っ|述べ)て(?:いません|いない)|とは(?:言って|述べて)(?:いません|いない)|という意味では(?:ありません|ない)|では(?:ありません|ない)/u.test(clause) || Boolean(additionalDenial?.test(clause));
      affirmed = !denied;
    }
  }
  return affirmed;
}

export function containsUnsupportedSituationPremise(text, currentUserTexts) {
  return SITUATION_PREMISES.some(({ output, evidence }) =>
    output.test(text) && !hasCurrentUserSituationEvidence(currentUserTexts, evidence));
}

const TASK_ASSUMPTION = /(?:今日|昨日|前回)[^。！？\n]{0,40}(?:やり残|終わらなかった|未完了|残した(?:タスク|作業|仕事))|(?:やり残した|未完了の|残っている)(?:タスク|作業|仕事)/u;

// A read instruction needs a currently available memo asserted by its user.
// Reuse the existing quotation spans so reports do not become new commands.
const MEMO_READY_COMPLETE = /メモ(?:を|に(?:は)?|へ)[^。！？?\n]{0,80}(?:書いた|書きました|書いて(?:あります|ある|います|いる)|(?:用意|作成|準備)(?:しました|して(?:あります|ある|います|いる)))[。！!\s]*$|メモ(?:は|が)(?:今も|今は)?(?:手元に)?あります[。！!\s]*$/u;
const MEMO_NOT_READY = /メモ(?:は|が|も)(?:もう|まだ|今は|現在)?(?:手元に)?(?:ありません|ない|使えません|使えない)|メモ[^。！？?\n]{0,32}(?:処分し|捨て|なくし|失くし)(?:ました|た|て)|メモ[^。！？?\n]{0,32}書いて(?:いません|いない)|メモ[^。！？?\n]{0,32}(?:あるか|書いたか)[^。！？?\n]{0,12}(?:分かりません|わかりません|未確認)|メモ[^。！？?\n]{0,60}とは(?:言って|述べて)(?:いません|いない)/u;
const MEMO_ANAPHOR_NOT_READY = /^\s*(?:まだ|今は|現在|もう|あとで|後で)?(?:何も)?(?:書いて(?:いません|いない)|書いてない|手元に(?:ありません|ない)|使え(?:ません|ない)|(?:処分し|捨て)(?:ました|た))[。！!\s]*$/u;
function hasCurrentOwnReadyMemo(currentUserTexts) {
  let ready = false;
  let ownMemoReferent = false;
  for (const value of currentUserTexts) {
    const ownWords = stripJapaneseQuotationContent(value, true).replace(/"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
    for (const statement of ownWords.split(/(?<=[。！？?\n])/u)) {
      const mention = /メモ(?!帳)/u.exec(statement);
      if (!mention && !(ownMemoReferent && MEMO_ANAPHOR_NOT_READY.test(statement))) continue;
      const prefix = mention ? statement.slice(0, mention.index) : statement;
      const actor = [...prefix.matchAll(/([^\s、,。！？?]{1,40}?)(?:は|が)/gu)].at(-1)?.[1];
      const owner = /^(?:この|その|あの)$/u.test(prefix.trim())
        ? undefined
        : prefix.match(/([^\s、,。！？?]{1,24})の$/u)?.[1];
      const self = /^(?:私|私自身|自分|自分自身|自身)$/u;
      const memoTopic = /(?:一文|一言|言葉|文案)$/u;
      if ((actor && !self.test(actor) && !memoTopic.test(actor) && !/^(?:今|今日|現在|昨日|前回)$/u.test(actor)) || (owner && !self.test(owner))) continue;
      if (/[？?]|(?:と|って)(?:AI|アシスタント|ChatGPT)?(?:に)?(?:言われ|提案され)|(?:もし|仮に)[^。！？?\n]{0,24}メモ|メモ[^。！？?\n]{0,24}(?:あれば|あるなら|ある場合)/u.test(statement)) continue;
      if (mention) ownMemoReferent = true;
      // Preserve subject attribution across a comma; only the artifact state
      // may progress from affirmative to a following own denial.
      for (const clause of statement.split(/[、,]|(?<=あります|ありませんでした|ありません|書きました|書いた|用意しました|準備しました|作成しました)が|しかし|ただし/u)) {
        if (MEMO_NOT_READY.test(clause) || (ownMemoReferent && MEMO_ANAPHOR_NOT_READY.test(clause))) { ready = false; continue; }
        if (MEMO_READY_COMPLETE.test(clause)) ready = true;
      }
    }
  }
  return ready;
}
function containsExistingMemoReadInstruction(text, currentUserTexts) {
  const readInstruction = /メモ(?:の(?:内容|一文|一言|文章))?(?:で|を)[^。！？?\n]{0,24}(?:(?:確認し|見返し|読み返し|参照し)(?:て(?:みて)?ください|ましょう)|読(?:んで(?:みて)?ください|みましょう))(?:ね)?(?=[。！!\n」』]|$)/gu;
  return splitOutsideJapaneseQuotations(text).some(statement => [...statement.matchAll(readInstruction)].some(mention => {
    const quote = rentQuoteAt(statement, mention.index);
    if (quote) {
      if (rentIsFaithfulReportedQuotation(statement, quote, currentUserTexts)) return false;
      const suffix = statement.slice(quote.end);
      // A report of receiving the instruction is not the instruction itself.
      // Anchor the role to the matched quote's immediate suffix, not a distant
      // unrelated occurrence of '伝えてください' in the same statement.
      if (!/^[。！!\s]*$/u.test(suffix) && !/^\s*(?:と(?:伝えて|送って|言って)|を(?:試して|やってみて))(?:みて)?ください[。！!\s]*$/u.test(suffix)) return false;
    }
    const prefix = statement.slice(0, mention.index);
    if (/メモが(?:あれば|あるなら)[、,\s]*$/u.test(prefix)) return false;
    return true;
  }));
}

// Bounded to the observed existing-task/item and planned-task targets. A list
// mentioned by an assistant or another actor is not the user's available list.
function currentOwnTaskTargetState(currentUserTexts) {
  let task = false;
  let list = false;
  for (const value of currentUserTexts) {
    const own = stripJapaneseQuotationContent(value, true).replace(/"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
    for (const statement of splitOutsideJapaneseQuotations(own)) {
      const mention = /(?:作業|タスク|仕事|用事)(?:の)?(?:リスト|一覧|項目)?|(?:この|その)リスト/u.exec(statement);
      if (!mention) continue;
      const prefix = statement.slice(0, mention.index);
      const actor = [...prefix.matchAll(/([^\s、,。！？?]{1,24}?)(?:は|が)/gu)].at(-1)?.[1];
      const owner = prefix.match(/([^\s、,。！？?]{1,24})の$/u)?.[1];
      const self = /^(?:私|私自身|自分|自分自身|自身)$/u;
      if ((actor && !self.test(actor) && !/^(?:今|今日|現在|明日)$/u.test(actor)) || (owner && !self.test(owner))) continue;
      if (/[？?]|もし|仮に|(?:と|って)(?:AI|アシスタント|ChatGPT)?(?:に)?(?:言われ|提案され)/u.test(statement)) continue;
      for (const clause of statement.split(/[、,]|しかし|ただし|(?<=あります|ありません|作りました|作成しました)が/u)) {
        const listMention = /(?:作業|タスク|仕事|用事)(?:の)?(?:リスト|一覧|項目)|(?:この|その)リスト/u.test(clause);
        const negative = /(?:は|が|も)(?:もう|まだ|今は|現在)?(?:手元に)?(?:ありません|ない)|(?:捨て|処分し|なくし|失くし)(?:ました|た|て)|(?:作っ|作成し|用意し|書い)て(?:いません|いない)|(?:は|が)(?:まだ)?(?:空|空白)です|(?:あるか|作ったか)[^。！？?\n]{0,12}(?:分かりません|わかりません|未確認)|とは(?:言って|述べて)(?:いません|いない)/u.test(clause);
        if (negative) { if (listMention) list = false; else { task = false; list = false; } continue; }
        if (listMention && /(?:を[^。！？?\n]{0,30}(?:作りました|作成しました|用意しました|書きました)|(?:は|が)(?:今も|現在)?(?:手元に)?あります|(?:最初|先頭|一番目)の項目は[^。！？?\n]{1,40}です)/u.test(clause)) { task = true; list = true; continue; }
        if (/(?:作業|タスク|仕事|用事)(?:(?:は|が)(?:今も|現在)?(?:あります|残っています)|を[^。！？?\n]{0,32}(?:しています|進めています|行う予定です|進める予定です)|に取り組んでいます)/u.test(clause)) task = true;
      }
    }
  }
  return { task, list };
}
function containsUnstatedCurrentTaskTarget(text, currentUserTexts) {
  const state = currentOwnTaskTargetState(currentUserTexts);
  const families = [
    { pattern: /今ある(?:作業|タスク|仕事|用事)の(?:最初|先頭|一番目)の項目/gu, supported: state.list },
    { pattern: /(?:今日|本日|その日に)(?:行う予定の|(?:一番)?優先して進めたい)(?:作業|タスク|仕事|用事)/gu, supported: state.task },
  ];
  return families.some(({ pattern, supported }) => !supported &&
    splitOutsideJapaneseQuotations(text).some(statement => [...statement.matchAll(pattern)]
      .some(match => !rentOccurrenceIsNonAssertive(statement, match, currentUserTexts))));
}

export function containsUngroundedTaskAssumption(text, currentUserTexts) {
  return containsUnsupportedArtifactCauseAssertion(text, currentUserTexts) ||
    containsUnstatedCurrentTaskTarget(text, currentUserTexts) ||
    (TASK_ASSUMPTION.test(text) && !hasCurrentUserSituationEvidence(currentUserTexts, TASK_ASSUMPTION)) ||
    (containsExistingMemoReadInstruction(text, currentUserTexts) && !hasCurrentOwnReadyMemo(currentUserTexts));
}

// A service-use document does not establish a screen or a button. Keep this
// check bounded to procedure advice; the ACTI composer is not the service being
// described. Callers supply current-topic user words, never assistant history.
const PROCEDURE_CONTEXT = /説明資料|利用手順|操作手順|手順書|使い方|利用ガイド/u;
const INTERFACE_PREMISES = [
  {
    output: /何を(?:押す|クリックする|タップする)か|(?:ボタン|メニュー|アイコン|画面)[^。！？?\n「」『』、,]{0,16}(?:押(?:す|し|せ|さ)|クリック|タップ)|(?:押す|クリックする|タップする)(?:ボタン|メニュー|アイコン|場所)|ボタン操作/gu,
    evidence: /ボタン|クリック|タップ|押す操作/u,
  },
  {
    output: /何が表示されるか|(?:画面|ページ|メニュー)[^。！？?\n「」『』、,]{0,16}表示|表示され(?:る|た)(?:画面|内容|もの)|画面(?:に|の)(?:表示|内容|変化)|表示内容|操作画面|画面操作/gu,
    evidence: /画面|表示|アプリ|ブラウザ|ウェブサイト|Webサイト/iu,
  },
];
const INTERFACE_DENIAL = /(?:は|が|も)(?:まだ|現在|今は|今のところ)?(?:ありません|ない|存在しません|存在しない)|使いません|使わない|使って(?:いません|いない)|使用し(?:ません|ない)|ではなく|では(?:ありません|ない)|とは(?:言って|述べて)(?:いません|いない)|とは(?:限りません|限らない)|という意味では/u;

function hasProcedureInterfaceEvidence(userTexts, expression) {
  let supported = false;
  for (const text of userTexts) {
    const ownWords = text.replace(/「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, '');
    for (const statement of ownWords.split(/(?<=[。！？?\n])|[、,]|しかし|ただし|(?<=ません|ない|あります|です)が/u)) {
      if (!expression.test(statement)) continue;
      if (/(?:あるか|存在するか|使うか|使用するか)[^。！？?\n]{0,16}(?:分かりません|わかりません|分からない|わからない|不明|未確認|未定)/u.test(statement)) {
        supported = false;
        continue;
      }
      // Questions, hypothetical examples and another service cannot establish
      // a property of the current service. A later explicit denial cancels it.
      if (/[？?]|(?:です|ます|ある|いる)か[。\s]*$|もし|仮に|なら|場合|あれば|あったら|例えば|たとえば|一例|別の(?:サービス|資料)|他のサービス|と(?:AIに|言われ|言って|書かれ|提案され)|かもしれ/u.test(statement)) continue;
      supported = !INTERFACE_DENIAL.test(statement);
    }
  }
  return supported;
}

export function containsUnsupportedProcedureInterfacePremise(text, currentUserTexts = []) {
  if (!PROCEDURE_CONTEXT.test(currentUserTexts.join('\n'))) return false;
  return INTERFACE_PREMISES.some(({ output, evidence }) => {
    if (hasProcedureInterfaceEvidence(currentUserTexts, evidence)) return false;
    // Quoted labels in an instruction still impose a premise. Do not strip
    // them: the observed defect placed both invented UI steps inside quotes.
    return (text.match(/[^。！？?\n]+[。！？?]?/gu) || []).some(statement =>
      [...statement.matchAll(output)].some(match => {
        const suffix = statement.slice(match.index + match[0].length);
        if (/^(?:とは(?:限りません|限らない)|(?:という意味)?では(?:ありません|ない)|(?:こと|操作)?(?:は|が|も)?(?:ありません|ない|不要です|必要ありません))/u.test(suffix)) return false;
        if (/^(?:は|が)(?:あります|ある|存在します|存在する)(?:か|でしょうか)[？?。\s]*$/u.test(suffix)) return false;
        if (/^(?:が(?:ある|ない)(?:サービス)?(?:なら|場合|とき|時)|が(?:あれば|あったら)|を(?:使う|使用する|操作する|押す)(?:サービス)?(?:なら|場合|とき|時))/u.test(suffix)) return false;
        const prefix = statement.slice(0, match.index).split(/しかし|ただし|が[、,]/u).at(-1);
        const conditional = new RegExp(`(?:${evidence.source})(?:操作|表示)?(?:が(?:ある(?:サービス)?(?:なら|場合|とき|時)|あれば|あったら)|を(?:使う|使用する|操作する|押す)(?:サービス)?(?:なら|場合|とき|時))[^。！？?\\n]*$`, evidence.flags);
        // Only a condition on the UI property itself qualifies. A condition on
        // the reader ("初めて使う人なら") does not establish an interface.
        return !conditional.test(prefix);
      }));
  });
}

/** Restricting the conversation itself is different from naming something to avoid within it. */
export function containsConversationRestriction(text) {
  return /業務の確認だけ|[「『]?事実[」』]?だけ|話すのは[^。！？\n]{0,30}だけにする/u.test(text) ||
    /(?:話題|会話)(?:そのもの|自体)?(?:は|を)(?:(?:できるだけ|なるべく|極力|一度|いったん|一旦|しばらく)[、,\s]*)*避け/u.test(text) ||
    /(?:話題|会話)(?:の(?:範囲|内容))?(?:は|を)[^。！？\n]{0,16}限定/u.test(text);
}

// Only the observed present-tense or noun task target in a future instruction is
// aligned. Quotes, past reports and explicit user-supplied today references
// remain intact; this is not a general relative-date interpreter.
function ambiguousFutureActionDaySpans(text, lastUserText, currentUserTexts) {
  lastUserText = resolveShorteningActionTimeRequest(lastUserText, currentUserTexts);
  if (!/明日/u.test(lastUserText) ||
      !/行動|作業|一歩|何をすれば|どうすれば|できること|すること|やること|始める/u.test(lastUserText) ||
      /文案|文面|せりふ|セリフ|台詞|言い方|伝える(?:言葉|一言)|最初の一言/u.test(lastUserText)) return [];
  const quotes = /「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu;
  const unquoted = (value) => value.replace(quotes, (quote) => ' '.repeat(quote.length));
  if (currentUserTexts.some((value) => /今日|本日/u.test(
    unquoted(value).replace(/(?:今日|本日)(?:ではなく|じゃなく)/gu, '')
  ))) return [];
  const visible = unquoted(text);
  return [...visible.matchAll(/(?:今日|本日)(?:(?=(?:(?:行う|やる|する|取り組む|片付ける)(?:予定の)?|(?:一番)?優先して進めたい)(?:作業|タスク|仕事|用事|こと))|の(?=作業|タスク|仕事|用事))/gu)]
    .filter((match) => /(?:明日|翌日|翌朝)[^。！？\n]{0,80}$/u.test(visible.slice(0, match.index)))
    // Retrospective verbs make the prior-day target explicit rather than
    // ambiguously describing a task to perform on the future execution day.
    .filter((match) => {
      const target = /^(?:(?:行う|やる|する|取り組む|片付ける)(?:予定の)?|(?:一番)?優先して進めたい)?(?:作業|タスク|仕事|用事|こと)(?:を|について)/u.exec(visible.slice(match.index + match[0].length));
      if (!target) return true;
      const clause = visible.slice(match.index + match[0].length + target[0].length).split(/[。！？\n]/u)[0].slice(0, 32);
      const retrospective = /振り返|思い出/u.exec(clause);
      if (!retrospective) return true;
      // A separate action before reflection still makes the task's day
      // ambiguous. Match verb forms, not nouns such as 書面 or メモ.
      return /書(?:く|き|い|か)|メモ(?:し|する)|記録(?:し|する)|選(?:ぶ|び|ん|ば)|決め|始め|進め|確認(?:し|する)|伝え|送(?:る|り|っ|ら)|開(?:く|き|い|か)|読(?:む|み|ん|ま)|実行(?:し|する)|終え/u.test(clause.slice(0, retrospective.index));
    })
    .map((match) => ({ index: match.index, length: match[0].length, replacement: match[0].endsWith('の') ? 'その日の' : 'その日に' }));
}

export function containsAmbiguousFutureActionDayReference(text, lastUserText, currentUserTexts = [lastUserText]) {
  return ambiguousFutureActionDaySpans(text, lastUserText, currentUserTexts).length > 0;
}

export function alignFutureActionDayReferences(text, lastUserText, currentUserTexts = [lastUserText]) {
  return ambiguousFutureActionDaySpans(text, lastUserText, currentUserTexts)
    .reverse().reduce((aligned, span) => `${aligned.slice(0, span.index)}${span.replacement}${aligned.slice(span.index + span.length)}`, text);
}

// Bounded to the observed own-partner rent explanation failure.
const RENT_MISSING_REASON = /(?:理由[^。！？?\n]{0,40})?説明(?:が|は)?(?:ありません|ない)|(?:理由を[^。！？?\n]{0,20})?(?:説明して|教えて)(?:くれません|もらえません)/u;
const RENT_EXPLAINED_REASON = /(?:理由|事情)[^。！？?\n]{0,24}(?:説明して|教えて)くれ(?:ました|ています)|説明(?:が|は)あり(?:ました|ます)|理由(?:が|は)(?:分かりました|わかりました)/u;
const RENT_LOADED_REPLY_FAMILIES = [
  { output: /対話を拒(?:まれ|否され)/gu, evidence: /対話を拒(?:まれ|否され)/u, subject: 'self', omitted: 'self' },
  { output: /対話を拒(?:んで|否して)/gu, evidence: /対話を拒(?:んで|否して)/u, subject: 'partner', omitted: null },
  { output: /途方に暮れ/gu, evidence: /途方に暮れ/u, subject: 'self', omitted: 'self' },
  { output: /追及から逃げ/gu, evidence: /追及から逃げ/u, subject: 'partner', omitted: 'partner' },
];
function rentOwnWords(value) {
  return stripJapaneseQuotationContent(value, true).replace(/"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
}
function rentReportedOrHypothetical(statement) {
  return /[？?]|もし|仮に|(?:と|って)(?:AI(?:に|は)?|言われ|言って|書かれ|提案され)/u.test(statement);
}
function rentStateUpdateActorIsOwnCase(statement, matchIndex, correction = false) {
  const prefix=statement.slice(0,matchIndex);
  const actor=[...prefix.matchAll(/([^\s、。！？?]{1,24}?)(?:は|が)/gu)].at(-1)?.[1];
  if (!actor || /^(?:今|現在|以前|当時|その時|過去|その後)$/u.test(actor)) return true;
  return (correction ? /^(?:私|私自身|自分)$/u : /^(?:夫|私の夫|私|私自身|自分)$/u).test(actor);
}
function rentReasonIsCurrentlyMissing(userTexts) {
  let ownRent = false;
  let missing = false;
  for (const value of userTexts) {
    for (const rawStatement of splitOutsideJapaneseQuotations(value)) {
      const correction=/説明(?:が|は)?(?:ありません|ない)[」』"]?(?:と|とは)(?:言って|述べて)(?:いません|いない)/u.exec(rawStatement);
      // Consume only the corrected statement. A later statement in the same
      // turn may affirm a different state, but this denial cannot re-enter.
      if (ownRent && correction && rentStateUpdateActorIsOwnCase(rawStatement,correction.index,true)) { missing=false; continue; }
      const statement=rentOwnWords(rawStatement);
      if (rentReportedOrHypothetical(statement)) continue;
      if (/^\s*(?:(?:私は|私の|自分の))?夫(?:が|は)[^。！？?\n]{0,20}家賃/u.test(statement)) ownRent=true;
      if (!ownRent) continue;
      const explained=RENT_EXPLAINED_REASON.exec(statement);
      if (explained && rentStateUpdateActorIsOwnCase(statement,explained.index)) { missing=false; continue; }
      const absence=RENT_MISSING_REASON.exec(statement);
      if (!absence || !rentStateUpdateActorIsOwnCase(statement,absence.index))continue;
      if (/説明(?:が|は)?ないわけでは(?:ありません|ない)/u.test(statement)) { missing=false; continue; }
      missing=true;
    }
  }
  return missing;
}
function rentQuoteAt(text, position) {
  const close = new Map([['「','」'],['『','』'],['"','"'],["'", "'"]]);
  const stack = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (stack.length && ch === stack.at(-1)) {
      stack.pop();
      if (!stack.length) { if (start <= position && position <= i) return { start, end:i+1, text:text.slice(start,i+1) }; start=-1; }
    } else if (close.has(ch)) { if (!stack.length) start=i; stack.push(close.get(ch)); }
  }
  return null;
}
function rentReportedQuotationOrigin(text, quote) {
  const suffix=text.slice(quote.end);
  const report=/^\s*と((?:AI|担当者)(?:に|から))?(?:言われた|言われました|言った|話した|書かれた|書いてあった)(?:のですね|という報告ですね|そうです)?[。！!\s]*$/u.exec(suffix);
  if(!report)return null;
  const suffixOrigin=report[1]?.replace(/(?:に|から)$/u,'');
  const prefixOrigin=/(AI|担当者)(?:に|から)\s*$/u.exec(text.slice(0,quote.start))?.[1];
  return suffixOrigin||prefixOrigin||'unspecified';
}
function rentIsFaithfulReportedQuotation(statement,quote,userTexts) {
  const outputOrigin=rentReportedQuotationOrigin(statement,quote);
  if(outputOrigin===null)return false;
  return userTexts.some(value=>{
    let start=value.indexOf(quote.text);
    while(start>=0){
      const sourceQuote={start,end:start+quote.text.length,text:quote.text};
      if(rentReportedQuotationOrigin(value,sourceQuote)===outputOrigin)return true;
      start=value.indexOf(quote.text,start+quote.text.length);
    }
    return false;
  });
}
function rentOccurrenceIsNonAssertive(statement, match, userTexts) {
  const end = match.index + match[0].length;
  const suffix = statement.slice(end).replace(/^[」』"']+/u,'');
  // A denial and a genuine existence check are not an asserted state. A WH
  // question asking why the state exists is still a premise and is not here.
  if (/^(?:(?:て|で)?(?:は)?(?:いません|いない)|る(?:わけ)?では(?:ありません|ない)|(?:て(?:いる|いた|います|いました))?(?:と|とは)(?:言って|述べて)(?:いません|いない)|(?:て(?:いる|いた|います|いました))?とは(?:断定|判断|決めつけ)(?:できません|ない)|という意味では(?:ありません|ない))/u.test(suffix)) return true;
  if (/^(?:て)?(?:います|いる|いるの)?(?:か|でしょうか)[？?。\s]*$/u.test(suffix)) return true;
  const before = statement.slice(0,match.index).split(/[、,]|しかし|ただし/u).at(-1);
  if (/(?:もし|仮に)[^。！？?\n]*$/u.test(before) && /^[^。！？?\n]{0,24}(?:なら|場合|とき|時)/u.test(suffix)) return true;
  // Only a faithful, user-supplied reported quotation is exempt. A fresh
  // outbound draft (「...」と伝えてください) does not meet this condition.
  const quote = rentQuoteAt(statement,match.index);
  if (quote && rentIsFaithfulReportedQuotation(statement,quote,userTexts)) return true;
  return false;
}
function rentCanonicalSubject(statement, match, family) {
  const prefix=statement.slice(0,match.index);
  const actor=[...prefix.matchAll(/([^\s、。！？?]{1,24}?)(?:は|が)/gu)].at(-1)?.[1];
  if (!actor || /^(?:今|現在|以前|当時|その時|過去)$/u.test(actor)) return family.omitted;
  if (/^(?:あなた|私|私自身|自分|自分自身)$/u.test(actor)) return 'self';
  if (/^(?:夫|私の夫)$/u.test(actor)) return 'partner';
  return null;
}
function rentFamilyHasDirectUserEvidence(userTexts, family, outputStatement, outputMatch) {
  const outputSubject=rentCanonicalSubject(outputStatement,outputMatch,family);
  if(outputSubject!==family.subject)return false;
  const outPrefix=outputStatement.slice(0,outputMatch.index);
  const outputPast=/(?:以前|当時|その時|過去)[^。！？?\n]*$/u.test(outPrefix) || /^(?:て|で)?(?:いた|いました)/u.test(outputStatement.slice(outputMatch.index+outputMatch[0].length));
  let supported=false;
  for(const value of userTexts) for(const statement of splitOutsideJapaneseQuotations(rentOwnWords(value))) {
    const match=family.evidence.exec(statement); if(!match)continue;
    if(rentReportedOrHypothetical(statement))continue;
    const prefix=statement.slice(0,match.index);
    const evidenceSubject=rentCanonicalSubject(statement,match,family);
    if(evidenceSubject!==outputSubject)continue;
    const past=/(?:以前|当時|その時|過去)[^。！？?\n]*$/u.test(prefix) || /^(?:て|で)?(?:いた|いました)/u.test(statement.slice(match.index+match[0].length));
    if(past!==outputPast)continue;
    const suffix=statement.slice(match.index+match[0].length);
    supported=!/^(?:(?:て|で)?(?:は)?(?:いません|いない)|る(?:わけ)?では(?:ありません|ない)|とは(?:言って|述べて)(?:いません|いない))/u.test(suffix);
  }
  return supported;
}
export function containsUnsupportedRentExplanationReply(text, currentUserTexts = []) {
  if (!rentReasonIsCurrentlyMissing(currentUserTexts)) return false;
  for (const statement of splitOutsideJapaneseQuotations(text)) {
    // The exact observed re-question asks for an explanation already reported
    // unavailable. It is not a new question about a different topic or intent.
    const repeated=/家賃[^。！？?\n]{0,24}理由を何と説明していますか/gu;
    for(const match of statement.matchAll(repeated)) if(!rentOccurrenceIsNonAssertive(statement,match,currentUserTexts))return true;
    for(const family of RENT_LOADED_REPLY_FAMILIES) for(const match of statement.matchAll(family.output)) {
      if(rentOccurrenceIsNonAssertive(statement,match,currentUserTexts))continue;
      if(!rentFamilyHasDirectUserEvidence(currentUserTexts,family,statement,match))return true;
    }
  }
  return false;
}

// Bounded to the observed explanation-length diagnosis. Merely showing a
// sentence or its structure does not establish the user's explanation of cause.
const ARTIFACT_CAUSE_CONTEXT = /資料|説明文|目的の説明|利用目的|原稿|文章/u;
const ARTIFACT_PACKING = /(?:特徴|メリット)[^。！？?\n]{0,32}(?:一つの文|ひとつの文|1つの文|一文|1文|同じ文)[^。！？?\n]{0,20}(?:詰め込|盛り込|詰め)|(?:一つの文|ひとつの文|1つの文|一文|1文|同じ文)[^。！？?\n]{0,32}(?:特徴|メリット)[^。！？?\n]{0,20}(?:詰め込|盛り込|詰め)/u;

function artifactCauseQuotes(value) {
  const spans = [];
  const stack = [];
  let start = -1;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const close = character === '「' ? '」' : character === '『' ? '』' : null;
    if (close) {
      if (stack.length === 0) start = index;
      stack.push(close);
    } else if (stack.length > 0 && character === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) spans.push({ start, end: index + 1, content: value.slice(start + 1, index) });
    } else if (stack.length === 0 && (character === '"' || character === "'")) {
      const end = value.indexOf(character, index + 1);
      if (end > index) { spans.push({ start: index, end: end + 1, content: value.slice(index + 1, end) }); index = end; }
    }
  }
  return spans;
}

function artifactCauseOutside(value) {
  return artifactCauseQuotes(value).reverse().reduce((outside, span) => {
    // Quoted labels still name the claimed content. A quoted opinion or body
    // is handled separately, never silently promoted to direct user causality.
    if (/^(?:サービスの)?(?:特徴|細かいメリット|メリット)$/u.test(span.content)) return outside;
    return `${outside.slice(0, span.start)}${' '.repeat(span.end - span.start)}${outside.slice(span.end)}`;
  }, value);
}

function artifactCauseClaims(value) {
  const statement = value.normalize('NFKC').replace(/[ \t]/gu, '');
  const matches = [...statement.matchAll(new RegExp(ARTIFACT_PACKING.source, 'gu'))];
  return matches.map((packing, index) => {
    const stem = /詰め込|盛り込|詰め/u.exec(packing[0]);
    const end = packing.index + stem.index + stem[0].length;
    const previousEnd = index === 0 ? 0 : matches[index - 1].index + matches[index - 1][0].length;
    const prefix = statement.slice(previousEnd, packing.index);
    const tail = statement.slice(end, matches[index + 1]?.index ?? statement.length);
    const causal = /(?:原因|理由)(?:は|が)|長く(?:なる|なった|なっている)のは|なぜ/u.test(prefix) ||
      /^(?:みすぎている|んでいる|んだ|た|む)(?:こと|の)?(?:にある|にあります|が原因|が理由|ためです|からです)/u.test(tail) ||
      /^(?:みすぎている|んでいる|んだ|た|む)ため[、,]?[^。！？?\n]{0,20}(?:説明|文章|文|資料)?(?:が|は)?長く(?:なって|なり|なる|なった)/u.test(tail);
    const state = '(?:みすぎている|んでいる|んだ|た|む)';
    const denied = /^(?:んで|みすぎて)(?:は|も)?(?:いません|いない)/u.test(tail) ||
      new RegExp(`^${state}(?:こと|の)?(?:にある|が原因|が理由)?(?:では|じゃ|わけでは)(?:ありません|ない)`, 'u').test(tail) ||
      new RegExp(`^${state}(?:こと|の)?(?:にある|が原因|が理由)?とは(?:限りません|限らない|断定できません|断定できない|言っていません|言っていない|述べていません|述べていない)`, 'u').test(tail) ||
      new RegExp(`^${state}(?:こと|の)?(?:が|は)?(?:原因|理由)(?:では|じゃ)(?:ありません|ない)`, 'u').test(tail) ||
      new RegExp(`^${state}(?:こと|の)?(?:にある|が原因|が理由)?(?:か|のか)[^。！？?\\n]{0,12}(?:分かりません|わかりません|分からない|わからない|不明)`, 'u').test(tail);
    const conditional = /^(?:みすぎて(?:いる|いた)|んで(?:いる|いた)|た|む)(?:なら|場合|とき|時|のであれば)|^(?:みすぎて|んで)(?:いれば|いたら)/u.test(tail);
    // A local uncertain cause is a hypothesis, not the categorical diagnosis
    // observed here; it also cannot establish a user's own causal evidence.
    const hypothetical = new RegExp(`^${state}(?:こと|の)?(?:にある|が原因|が理由)?(?:の)?かもしれ(?:ません|ない)`, 'u').test(tail);
    const general = /^(?:一般に|一般論として|一般例として)/u.test(prefix) &&
      !/(?:あなた|今の|この|現在の|一枚目)[^。！？?\n]{0,20}(?:資料|説明|文|原因|理由)/u.test(prefix);
    const contents = (/特徴/u.test(packing[0]) ? 1 : 0) | (/メリット/u.test(packing[0]) ? 2 : 0);
    return { causal, denied, conditional, hypothetical, general, contents };
  });
}

function artifactCauseReportSource(prefix, suffix) {
  const before = /([^\s、。！？?「『]{1,20}?)(?:から|は|が)[、,\s]*$/u.exec(prefix)?.[1];
  const after = /^(?:と|って)([^\s、。！？?]{1,20}?)に(?:言われ|説明され|指摘され)/u.exec(suffix)?.[1];
  return before || after || '';
}

function artifactCauseIsFaithfulReport(statement, quote, currentUserTexts) {
  const suffix = statement.slice(quote.end);
  if (!/^(?:と|って)(?:(?:[^\s、。！？?]{1,20})に)?(?:言われ|言った|言って|説明され|説明した|指摘され|指摘した)/u.test(suffix)) return false;
  const source = artifactCauseReportSource(statement.slice(0, quote.start), suffix);
  return currentUserTexts.some(value => artifactCauseQuotes(value).some(userQuote =>
    userQuote.content === quote.content &&
    artifactCauseReportSource(value.slice(0, userQuote.start), value.slice(userQuote.end)) === source &&
    /^(?:と|って)(?:(?:[^\s、。！？?]{1,20})に)?(?:言われ|言った|言って|説明され|説明した|指摘され|指摘した)/u.test(value.slice(userQuote.end))
  ));
}

function artifactCauseOwnCurrentSubject(statement) {
  return !/(?:担当者|夫|妻|友人|同僚|上司|[^\s、。！？?]{1,12}さん)(?:は|が|の(?:資料|説明|文))|(?:以前|前|別|他)の(?:資料|説明|文)|以前|当時|過去|昔/u.test(statement);
}

function artifactCauseDirectUserEvidence(currentUserTexts) {
  let supported = 0;
  for (const value of currentUserTexts) {
    if (/話題を変|別件|今度は/u.test(value)) supported = 0;
    for (const raw of splitOutsideJapaneseQuotations(value)) {
      const quotes = artifactCauseQuotes(raw);
      if (quotes.some(quote => artifactCauseClaims(quote.content).some(claim => claim.causal) &&
        /^(?:と|とは)(?:言って|述べて)(?:いません|いない)/u.test(raw.slice(quote.end)))) {
        supported = 0;
        continue;
      }
      const statement = artifactCauseOutside(raw);
      const claims = artifactCauseClaims(statement);
      if (claims.length === 0) continue;
      // The speaker must affirm their current artifact's own causal account.
      // Third-party reports, future plans and actual structure alone do not.
      if (!artifactCauseOwnCurrentSubject(statement) || /予定|これから/u.test(statement)) continue;
      if (/(?:と|って)(?:(?:AI|アシスタント|ChatGPT|担当者|同僚|上司)(?:に|から))?(?:言われ|言って|説明され|指摘され)|(?:^|[、,])(?:もし|仮に)/u.test(statement)) continue;
      for (const claim of claims) {
        // The later statement may deny the same current structure without
        // repeating the word 原因. That still revokes the old causal account.
        if (claim.denied) { supported = 0; continue; }
        if (claim.hypothetical || /(?:と思|気が|可能性)/u.test(statement)) { supported = 0; continue; }
        if (!claim.causal || claim.conditional || claim.general || /[？?]/u.test(statement)) continue;
        supported = claim.contents;
      }
    }
  }
  return supported;
}

export function containsUnsupportedArtifactCauseAssertion(text, currentUserTexts = []) {
  if (!ARTIFACT_CAUSE_CONTEXT.test(currentUserTexts.join('\n'))) return false;
  const evidence = artifactCauseDirectUserEvidence(currentUserTexts);
  const unsupported = (claim, statement) => claim.causal && !claim.denied && !claim.conditional && !claim.hypothetical && !claim.general &&
    (!artifactCauseOwnCurrentSubject(statement) || (evidence & claim.contents) !== claim.contents);
  return splitOutsideJapaneseQuotations(text).some(statement => {
    if (artifactCauseClaims(artifactCauseOutside(statement)).some(claim => unsupported(claim, statement))) return true;
    return artifactCauseQuotes(statement).some(quote => {
      if (artifactCauseIsFaithfulReport(statement, quote, currentUserTexts)) return false;
      return artifactCauseClaims(quote.content).some(claim => unsupported(claim, statement) ||
        (claim.causal && !claim.denied && !claim.conditional && !claim.hypothetical && !claim.general && !artifactCauseOwnCurrentSubject(quote.content)));
    });
  });
}
