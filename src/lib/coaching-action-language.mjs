/** A start verb with only an unspecified task restates the requested action. */
export function containsCircularSingleAction(text) {
  const unquoted = text.replace(/「[^」]*」|『[^』]*』/gu, '').replace(/\s+/gu, '');
  return /(?:最初に(?:行う|する|取り組む)|最初の)(?:作業|タスク|行動)(?:に|を)(?:(?:一|1|ひと)つだけ)?(?:着手して|取り組んで|始めて|開始して|進めて)(?:みて)?ください[。！!]*$/u.test(unquoted);
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
