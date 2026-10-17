import { describe, expect, it } from 'vitest';
import { containsUnsupportedConcernPremise as contains, removeUnsupportedConcernPremise as remove, currentTopicUserTexts } from '../src/lib/coaching-emotion-language.mjs';
const facts = ['友人に断りたい予定があるのに、返事を先延ばしにしています。', '断ると関係が悪くなる気がします。', 'そうかも。'];
describe('ordinary polite concern inflections retain user-grounded ownership', () => {
  it.each(['送る文面にも迷いますね。', '文面に迷います。', 'どの言葉に迷いますか？', '返事に困りますね。'])('detects an unreported current concern: %s', text => {
    expect(contains(text, facts)).toBe(true);
    expect(remove(text+'友人に伝えたい言葉はありますか？', facts)).toBe('友人に伝えたい言葉はありますか？');
  });
  it.each([
    ['文面に迷っています。','文面に迷いますね。'],
    ['文面に迷います。','文面に迷いますね。'],
    ['友人への返事に困っています。','友人への返事に困りますね。'],
    ['友人への返事に困ります。','友人への返事に困りますね。'],
  ])('preserves an explicitly reported present state: %s', (user,reply) => {
    expect(contains(reply,[...facts.slice(0,2),user,'そうかも。'])).toBe(false);
    expect(remove(reply,[user])).toBe(reply);
  });
  it.each(['今は文面に迷いません。','文面に迷っていません。','友人は文面に迷います。','友人は「文面に迷います」と言いました。','もし文面に迷っているなら考えます。','文面に迷いますか？'])('does not treat a negation, other actor or hypothetical as user evidence: %s', user => {
    expect(contains('文面に迷いますね。',[...facts,user])).toBe(true);
  });
  it('retracts an earlier own report after a direct negative', () => {
    expect(contains('文面に迷いますね。',['文面に迷います。','今は迷いません。','そうかも。'])).toBe(true);
  });
  it('does not carry an older topic into a new topic', () => {
    expect(contains('文面に迷いますね。',currentTopicUserTexts(['文面に迷います。','話題を変えて、別の友人に返事をします。','そうかも。']))).toBe(true);
  });
  it.each(['文面に迷いますか？','文面に迷っていることはありますか？','もし文面に迷っているなら、確認できます。','文面に迷いません。','文面に迷っていません。'])('preserves an actual question, conditional or denial: %s', text => {
    expect(contains(text,facts)).toBe(false);expect(remove(text,facts)).toBe(text);
  });
  it('preserves a faithful third-party quotation without assigning it to the user', () => {
    const text='友人は「文面に迷います」と言いました。';
    expect(contains(text,[text])).toBe(false);expect(remove(text,[text])).toBe(text);
  });
});
