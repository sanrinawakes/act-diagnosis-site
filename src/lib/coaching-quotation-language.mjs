const QUOTE_CLOSE = new Map([['「', '」'], ['『', '』']]);

/** Sentence filtering must keep a quoted proposal and its suffix together. */
export function splitOutsideJapaneseQuotations(text) {
  const segments = [];
  const stack = [];
  let pending = '';
  for (const character of text) {
    pending += character;
    if (QUOTE_CLOSE.has(character)) stack.push(QUOTE_CLOSE.get(character));
    else if (character === stack.at(-1)) stack.pop();
    if (stack.length === 0 && /[。！？?\n]/u.test(character)) {
      segments.push(pending);
      pending = '';
    }
  }
  if (pending) segments.push(pending);
  return segments;
}

export function containsUnbalancedJapaneseQuotation(text) {
  const stack = [];
  for (const character of text) {
    if (QUOTE_CLOSE.has(character)) stack.push(QUOTE_CLOSE.get(character));
    else if (/[」』]/u.test(character)) {
      if (stack.pop() !== character) return true;
    }
  }
  return stack.length > 0;
}

/** Tone adjustments apply to the coach's voice, while proposed wording stays intact. */
export function softenAcknowledgementsOutsideQuotations(text) {
  const stack = [];
  let outside = '';
  let result = '';
  const flush = () => {
    result += outside.replace(/承知いたしました[。]?/gu, 'わかりました。')
      .replace(/[、,]?と承知しました[。]?/gu, '、確認しました。')
      .replace(/承知しました[。]?/gu, 'わかりました。');
    outside = '';
  };
  for (const character of text) {
    if (QUOTE_CLOSE.has(character)) {
      if (stack.length === 0) flush();
      stack.push(QUOTE_CLOSE.get(character));
      result += character;
    } else if (stack.length > 0) {
      result += character;
      if (character === stack.at(-1)) stack.pop();
    } else outside += character;
  }
  flush();
  return result;
}

/** Remove complete quoted content without exposing text from nested quotes. */
export function stripJapaneseQuotationContent(text, preserveLength = false) {
  const stack = [];
  let result = '';
  for (const character of text) {
    if (QUOTE_CLOSE.has(character)) {
      stack.push(QUOTE_CLOSE.get(character));
      if (preserveLength) result += ' '.repeat(character.length);
    } else if (stack.length > 0) {
      if (preserveLength) result += ' '.repeat(character.length);
      if (character === stack.at(-1)) stack.pop();
    } else result += character;
  }
  return result;
}
