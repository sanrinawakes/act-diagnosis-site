/** A start verb with only an unspecified task restates the requested action. */
export function containsCircularSingleAction(text) {
  const unquoted = text.replace(/「[^」]*」|『[^』]*』/gu, '').replace(/\s+/gu, '');
  return /(?:最初に(?:行う|する|取り組む)|最初の)(?:作業|タスク|行動)(?:に|を)(?:(?:一|1|ひと)つだけ)?(?:着手して|取り組んで|始めて|開始して|進めて)(?:みて)?ください[。！!]*$/u.test(unquoted);
}

/** A conditional follow-up is still a second instructed communication action. */
export function containsChainedCommunicationInstructions(text, lastUserText = '') {
  const ownRequest = lastUserText.replace(/「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, '');
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
  if (!single && multipleRequested) return false;
  // Draft content can itself describe a sequence. Only instructions outside
  // the quoted wording count, including instructions after a closing quote.
  const outside = text.replace(/「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, quote => ' '.repeat(quote.length));
  return /(?:伝え(?:し)?|話し|説明し|答え|返事(?:を)?し)(?:てから|た後(?:に|で)?|[、,]\s*(?:その後|続いて|次に))[^。！？?\n]{0,80}(?:(?:尋ね|質問し|確認し)(?:て(?:みて)?ください|ましょう|てみませんか|てはどうでしょうか)|聞(?:いて(?:みて)?ください|きましょう))/u.test(outside);
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
export function hasCurrentUserSituationEvidence(currentUserTexts, expression) {
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
      const denied = /(?:は|が|も)(?:ありません|ない)|(?:受け|作っ|止まっ|され|し|言っ|述べ)て(?:いません|いない)|とは(?:言って|述べて)(?:いません|いない)|という意味では(?:ありません|ない)|では(?:ありません|ない)/u.test(clause);
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

export function containsUngroundedTaskAssumption(text, currentUserTexts) {
  return TASK_ASSUMPTION.test(text) && !hasCurrentUserSituationEvidence(currentUserTexts, TASK_ASSUMPTION);
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
  if (!/明日/u.test(lastUserText) ||
      !/行動|作業|一歩|何をすれば|どうすれば|できること|すること|やること|始める/u.test(lastUserText) ||
      /文案|文面|せりふ|セリフ|台詞|言い方|伝える(?:言葉|一言)|最初の一言/u.test(lastUserText)) return [];
  const quotes = /「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu;
  const unquoted = (value) => value.replace(quotes, (quote) => ' '.repeat(quote.length));
  if (currentUserTexts.some((value) => /今日|本日/u.test(
    unquoted(value).replace(/(?:今日|本日)(?:ではなく|じゃなく)/gu, '')
  ))) return [];
  const visible = unquoted(text);
  return [...visible.matchAll(/(?:今日|本日)(?:(?=(?:行う|やる|する|取り組む|片付ける)(?:作業|タスク|仕事|用事|こと))|の(?=作業|タスク|仕事|用事))/gu)]
    .filter((match) => /(?:明日|翌日|翌朝)[^。！？\n]{0,80}$/u.test(visible.slice(0, match.index)))
    // Retrospective verbs make the prior-day target explicit rather than
    // ambiguously describing a task to perform on the future execution day.
    .filter((match) => {
      const target = /^(?:(?:行う|やる|する|取り組む|片付ける))?(?:作業|タスク|仕事|用事|こと)(?:を|について)/u.exec(visible.slice(match.index + match[0].length));
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
