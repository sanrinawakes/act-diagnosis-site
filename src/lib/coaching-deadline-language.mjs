/** @param {string} text @param {string[]} userTexts */
export function stripAttributedDeadlineQuotes(text, userTexts = []) {
  // Do this before sentence splitting: a faithful quoted report can itself
  // contain punctuation. New promises in an outbound draft are not exempt.
  return text.replace(/(?:「([^」]+)」|『([^』]+)』)(?=と(?:言われ|聞い|伝えられ))/g, (quote, a, b) =>
    userTexts.some(user => {
      const index = user.indexOf(quote);
      return index >= 0 && /^と(?:言われ(?:ました|た)|聞きました|伝えられ(?:ました|た))(?:[。！\s]|$)/.test(user.slice(index + quote.length));
    }) ? '' : (a || b)).replace(/[「『][^」』]+[」』]と(?:は)?(?:言っていません|言われていません|保証していません)/g, '');
}

/**
 * Detect unqualified deadline outcome claims, not ordinary editing ability or
 * an action's goal. Context eligibility and factual dates are checked by the
 * caller. Shared with the offline standard evaluator to keep that gate honest.
 * @param {string} text
 * @param {string[]} userTexts
 */
export function containsDeadlineOutcomeAssurance(text, userTexts = []) {
  return stripAttributedDeadlineQuotes(text, userTexts).split(/(?<=[。！？?\n])/u).some(statement => {
    // Remove only the negated proposition, so a later assurance in the same
    // sentence cannot borrow that negation as an exemption.
    const assertion = statement.replace(/(?:間に合(?:います|いません|いそうです)|(?:完成|完了|提出|終了)(?:できます|します)|仕上げられます|間に合わせられます|終わります|(?:締切|期限|提出)は大丈夫です)(?:とは(?:限りません|言えません|言いません|断言できません)|という意味ではありません)/g, '');
    if (/間に合(?:います(?!か)|いません(?!か)|いそうです(?!か)|う(?:でしょう(?!か)|はず(?:です|だ)?(?=[。！、,\s]|$)|ことは確実(?:です)?(?=[。！、,\s]|$)|[。！])|わない[。！])/.test(assertion)) return true;
    // A leading question can assert guaranteed success/failure as its premise.
    if (/(?:必ず|絶対に|確実に)[^。！？?\n]{0,35}(?:間に合(?:う|わない)|完成できる|終わる)(?:と思|と考|のでは)/.test(assertion)) return true;
    const completion = /(?:完成|完了|提出|終了)(?:できます|します)(?!か)|仕上げられます(?!か)|間に合わせられます(?!か)|終わります(?!か)/;
    const deadlineTarget = /今日中|明日中|(?:期限|期日|締[め]?切[り]?)(?:まで)?に|時まで|提出(?:期限)?まで/;
    if (completion.test(assertion) && (deadlineTarget.test(assertion) || /必ず|絶対に|確実に|予定通り|予定どおり/.test(assertion))) return true;
    return /(?:締[め]?切[り]?|期限|提出)(?:は|も|なら|については)(?:きっと|必ず|絶対に)?大丈夫です(?!か)/.test(assertion);
  });
}
