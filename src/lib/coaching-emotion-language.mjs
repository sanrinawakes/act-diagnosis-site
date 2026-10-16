// Deliberately bounded to intense disturbance, not a general emotion classifier.
const INTENSE_EXPRESSIONS = [
  /(?:心|気持ち)(?:が|を)(?:かき|掻き)乱/u,
  /(?:心|気持ち)(?:が|を)(?:激しく|ひどく|大きく)(?:(?:かき|掻き)?乱)/u,
  /(?:心|気持ち)(?:が|を)乱/u,
  /(?:激しく|ひどく|大きく)動揺/u,
];
const ACTOR = '(?:担当者|上司|同僚|友人|相手|夫|妻|家族|彼女|彼|[^\\s、。！？?「」『』]{1,24}(?:さん|様|君|ちゃん))';
const normalize = value => value.normalize('NFKC').replace(/掻き/g, 'かき');

function statements(text) {
  // Keep punctuation inside a report quote with its attribution.
  return text.match(/(?:「[^」]*」|『[^』]*』|[^。！？?\n])+[。！？?]?|\n+/gu) || [];
}

function isNonAssertive(statement, allowYesNoQuestion = true) {
  if (/とは(?:言って|述べて|感じて)(?:いません|いない)|という意味では(?:ありません|ない)|(?:され|れ|し)て(?:いません|いない)|(?:乱れ|乱され|動揺し)(?:ません|ない)|(?:の|わけ)?では(?:ありません|ない)|とは(?:限りません|限らない)|と(?:は)?(?:決めつけ|断定)(?:ません|ない)/u.test(statement)) return true;
  if (/(?:もし|仮に)[^。！？?\n]*(?:なら|たら|あれば|場合|とき|時)/u.test(statement)) return true;
  // A yes/no question asks about a state; asking its reason presupposes it.
  return allowYesNoQuestion && /(?:います|いる|ます|でした|です)(?:か|でしょうか)[？?。\s]*$/u.test(statement) &&
    !/理由|なぜ|どうして|原因/u.test(statement);
}

function removeFaithfulReportedQuotes(statement, userTexts) {
  const reported = new RegExp(`(${ACTOR}(?:から|は|が))\\s*[「『]([^」』]+)[」』]と(?:言われ(?:た|ました|ています|ている)|言(?:っていた|っています|っている|った|いました)|話して(?:いた|います|いる))(?:のですね|んですね|のです|んです|そうです|ね)?`, 'gu');
  return statement.replace(reported, (match, actor, quote) => {
    const quoted = normalize(quote).replace(/[。！？?\s]+$/u, '');
    const faithful = userTexts.some(text => statements(text).some(source => {
      const original = normalize(source);
      return [...original.matchAll(new RegExp(reported.source, 'gu'))].some(report =>
        report[1] === actor &&
        normalize(report[2]).replace(/[。！？?\s]+$/u, '') === quoted &&
        !/^(?:とは|という意味では|わけでは)/u.test(original.slice(report.index + report[0].length)));
    }));
    return faithful ? '' : match;
  });
}

function clauses(statement) {
  return statement.replace(/(もし|仮に)[、,]\s*/gu, '$1')
    .split(/[、,]|(?<=ません|ます|ない|いる|た)が|しかし|ただし/u);
}

const isPast = statement => /以前|昔|当時|その時|昨日|先週|ていました|ていた/u.test(statement);

function subjectIdentity(value, fromUser, insideQuote = false) {
  if (/^(?:私|私自身)$/u.test(value)) return fromUser || insideQuote ? 'user' : 'assistant';
  if (value === 'あなた') return fromUser ? 'assistant' : 'user';
  return value;
}

function emotionSubjectFromPrefix(prefix, fromUser) {
  const matches = [...prefix.matchAll(/([^\s、。！？?「」『』]{1,24}(?:さん|様|君|ちゃん)|[^\s、。！？?「」『』]{1,24}?)(?:は|が)/gu)];
  // Only a subject directly attached to the state (or its owner) counts.
  // A causal event such as 仕事がうまくいかず does not own the following 心.
  const directTail = value => /^(?:(?:今|現在|以前|当時)(?:は)?|少し|とても|非常に|まさに|\s)*$/u.test(value) ||
    /^[^\s、。！？?「」『』]{1,24}の$/u.test(value);
  const explicit = matches.findLast(match =>
    !/^(?:今|現在|以前|昔|当時|その時|今日|その場面)(?:で)?$|[でに]$/u.test(match[1]) &&
    directTail(prefix.slice(match.index + match[0].length)));
  const insideQuote = prefix.lastIndexOf('「') > prefix.lastIndexOf('」') ||
    prefix.lastIndexOf('『') > prefix.lastIndexOf('』');
  const subject = explicit ? subjectIdentity(explicit[1], fromUser, insideQuote) : 'user';
  const lastParticle = matches.at(-1);
  const ownerText = prefix.slice(lastParticle ? lastParticle.index + lastParticle[0].length : 0);
  const owner = ownerText.match(/(私自身|私|自分自身|自分|自身)の$/u)?.[1] ||
    ownerText.match(/([^\s、。！？?「」『』]{1,24})の$/u)?.[1];
  if (/^(?:自分|自分自身|自身)$/u.test(owner || '')) return subject;
  return owner ? subjectIdentity(owner, fromUser, insideQuote) : subject;
}

function emotionSubject(clause, expression, fromUser) {
  const mention = expression.exec(clause);
  return emotionSubjectFromPrefix(clause.slice(0, mention?.index || 0), fromUser);
}

function userSupportsSubject(userTexts, expression, subject, past, nonAssertive = isNonAssertive, subjectOf = emotionSubject) {
  let affirmed = false;
  for (const text of userTexts) {
    for (const source of statements(normalize(text))) {
      // A third party's words and a proposed draft are not the user's state.
      const unquoted = source.replace(/「[^」]*」|『[^』]*』/gu, '');
      for (const clause of clauses(unquoted)) {
        const calm = clause.match(/(?:今は|現在は|今では|もう)[、,\s]*(?:心は|気持ちは)?落ち着(?:いています|いている|きました|いた)(?=[。！!\s]|が|ので|$)/u);
        if (!past && calm && emotionSubjectFromPrefix(clause.slice(0, clause.indexOf('落ち着')), true) === subject) affirmed = false;
        if (!expression.test(clause) || isPast(clause) !== past || subjectOf(clause, expression, true) !== subject) continue;
        if (/と言われ|と言って|と話して|と伝え|と言いたい|かもしれ/u.test(clause)) continue;
        if (nonAssertive(clause)) {
          if (!/[？?]|もし|仮に/u.test(clause)) affirmed = false;
        } else affirmed = true;
      }
    }
  }
  return affirmed;
}

function unsupportedStatements(text, userTexts) {
  const users = userTexts.map(normalize);
  return statements(text).filter(statement => {
    if (!INTENSE_EXPRESSIONS.some(expression => expression.test(statement))) return false;
    // A negated or hypothetical clause cannot exempt a separate assertion.
    return clauses(removeFaithfulReportedQuotes(statement, users)).some(clause =>
      !isNonAssertive(clause) && INTENSE_EXPRESSIONS.some(expression =>
        expression.test(clause) && !userSupportsSubject(users, expression,
          emotionSubject(clause, expression, false), isPast(clause))));
  });
}

/** @param {string} text @param {string[]} userTexts @returns {boolean} */
export function containsUnsupportedEmotionIntensity(text, userTexts = []) {
  return unsupportedStatements(text, userTexts).length > 0;
}

/** @param {string} text @param {string[]} userTexts @returns {string} */
export function removeUnsupportedEmotionIntensity(text, userTexts = []) {
  const unsupported = new Set(unsupportedStatements(text, userTexts));
  return statements(text).filter(statement => !unsupported.has(statement)).join('')
    .replace(/\n{3,}/gu, '\n\n').trim();
}

// These three ordinary states can also be presupposed by a question. A request
// to simplify a document, for example, does not establish that its author is
// struggling or hesitating. Keep the same subject/time/quote grounding used
// above, without classifying other feelings or inferring a state from events.
const CONCERN_EXPRESSIONS = [/迷(?:って|い|う|われ)/u, /困(?:って|った|り|る)/u, /不安/u];

function isNonAssertiveConcern(clause) {
  if (isNonAssertive(clause, false)) return true;
  if (/迷(?:って|われて|い)(?:は)?(?:いません|いない|ません|ない)|困(?:って|り)(?:は)?(?:いません|いない|ません|ない)|(?:迷い|不安)(?:は|が|も)?(?:ありません|ない)|不安(?:に感じて|では|じゃ)(?:いません|いない|ありません|ない)/u.test(clause)) return true;
  if (/(?:迷|困)[^。！？?\n]{0,16}(?:必要はありません|と(?:は)?(?:言って|述べて)(?:いません|いない))/u.test(clause)) return true;
  if (/(?:困り事|迷い|不安)があるとも$/u.test(clause.trim())) return true;
  // A conditional or a genuine existence/yes-no question does not assert the
  // state. A wh-question about its object/reason does, even with a question mark.
  if (/(?:迷っている|迷った|困っている|困った|不安(?:である)?)(?:なら|たら|場合|とき|時)/u.test(clause)) return true;
  if (/(?:こと|点|ところ|不安|迷い)(?:は|が)?(?:何か)?ありますか[？?。\s]*$/u.test(clause)) return true;
  return /(?:います|いる|ます|です)(?:か|でしょうか)[？?。\s]*$/u.test(clause) &&
    !/どの|どんな|どこ|何|理由|なぜ|どうして|原因/u.test(clause);
}

function concernSubject(clause, expression, fromUser) {
  const explicitSelf = clause.replace(/^(?:自分自身|自分|自身)(?=は|が)/u, fromUser ? '私' : 'あなた');
  const ownPrefix = explicitSelf.slice(0, expression.exec(explicitSelf)?.index || 0);
  // An event (感情が強くなりそうなのが...) is the object of a feeling.
  // Preserve an explicit outer topic/actor such as 同僚は before that event.
  if (/(?:の|こと|なの)(?:が|は)$|(?:今|現在|これから|今後|その|この|今回)の$/u.test(ownPrefix)) {
    const topicActor = ownPrefix.match(/^([^\s、。！？?「」『』]{1,24}?)は/u);
    return topicActor ? subjectIdentity(topicActor[1], fromUser) : 'user';
  }
  // Unlike 心が..., a concern can name its object between the actor and the
  // state: 同僚は対応に迷っています. That object is not a new subject.
  const actorWithObject = ownPrefix.match(/^([^\s、。！？?「」『』]{1,24}?)(?:は|が)([^。！？?\n]*?(?:に|で|について))$/u);
  if (actorWithObject) {
    return subjectIdentity(actorWithObject[1], fromUser);
  }
  return emotionSubject(explicitSelf, expression, fromUser);
}

function unsupportedConcernStatements(text, userTexts) {
  const users = userTexts.map(normalize);
  return statements(text).filter(statement =>
    clauses(removeFaithfulReportedQuotes(statement, users)).some(clause =>
      !isNonAssertiveConcern(clause) && CONCERN_EXPRESSIONS.some(expression =>
        expression.test(clause) && /迷(?:って|われ|う(?:理由|原因|点)|い(?:が|は|の(?:理由|原因)|を感じ))|困(?:って|った(?:場面|こと)|る場面|り(?:事|ごと))|不安(?:です|で|が|は|な|に|を(?:感じ|抱)|の(?:理由|原因|奥))/u.test(clause) && !userSupportsSubject(users, expression,
          concernSubject(clause, expression, false), isPast(clause), isNonAssertiveConcern, concernSubject))));
}

/** @param {string} text @param {string[]} userTexts @returns {boolean} */
export function containsUnsupportedConcernPremise(text, userTexts = []) {
  return unsupportedConcernStatements(text, userTexts).length > 0;
}

/** @param {string} text @param {string[]} userTexts @returns {string} */
export function removeUnsupportedConcernPremise(text, userTexts = []) {
  const unsupported = new Set(unsupportedConcernStatements(text, userTexts));
  return statements(text).filter(statement => !unsupported.has(statement)).join('')
    .replace(/\n{3,}/gu, '\n\n').trim();
}

/** User messages only; summaries and assistant wording are not state evidence. */
/** @param {string[]} userTexts @returns {string[]} */
export function currentTopicUserTexts(userTexts = []) {
  const marker = /話題を変|話を変|別の話|別件|ところで|今度は/u;
  const users = userTexts.filter(text => typeof text === 'string' && !text.startsWith('以下は過去の会話の保存済み要約です。'));
  const boundary = users.findLastIndex(text => marker.test(text));
  const current = users.slice(boundary < 0 ? 0 : boundary);
  if (boundary >= 0) {
    const lastMarker = [...current[0].matchAll(new RegExp(marker.source, 'gu'))].at(-1);
    current[0] = current[0].slice(lastMarker.index);
  }
  return current;
}
