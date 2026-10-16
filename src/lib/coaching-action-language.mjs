/** A start verb with only an unspecified task restates the requested action. */
export function containsCircularSingleAction(text) {
  const unquoted = text.replace(/「[^」]*」|『[^』]*』/gu, '').replace(/\s+/gu, '');
  return /(?:最初に(?:行う|する|取り組む)|最初の)(?:作業|タスク|行動)(?:に|を)(?:(?:一|1|ひと)つだけ)?(?:着手して|取り組んで|始めて|開始して|進めて)(?:みて)?ください[。！!]*$/u.test(unquoted);
}
