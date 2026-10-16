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
