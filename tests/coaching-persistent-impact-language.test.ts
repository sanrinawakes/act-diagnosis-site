import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { containsUnsupportedPersistentImpactPremise, removeUnsupportedPersistentImpactPremise } from '../src/lib/coaching-emotion-language.mjs';
// Exact synthetic public wire88chars and finite grounding controls; provider original NOT_CAPTURED.
const cases = [
  {
    "name": "actual public reply from empty history",
    "users": [
      "友人に断りたい予定があるのに、返事を先延ばしにしています。"
    ],
    "text": "断りたい予定があるのに返事を先延ばしにしていると、ずっと頭のどこかで気になって過ごしづらいですよね。\n\n断った後の友人との関係が気になって、返事を送るのが難しくなっていますか？",
    "unsupported": true,
    "remaining": "断った後の友人との関係が気になって、返事を送るのが難しくなっていますか？"
  },
  {
    "name": "ordinary concern and neutral empathy stay outside this family",
    "users": [
      "友人に断りたい予定があるのに、返事を先延ばしにしています。"
    ],
    "text": "友人への返事が気になるのですね。返事を先延ばしにしている状況から考えられます。",
    "unsupported": false
  },
  {
    "name": "own explicitly persistent state is retained",
    "users": [
      "ずっと頭のどこかで気になっています。"
    ],
    "text": "ずっと頭のどこかで気になっているのですね。",
    "unsupported": false
  },
  {
    "name": "own two attributes both retained",
    "users": [
      "ずっと頭のどこかで気になって過ごしづらいです。"
    ],
    "text": "ずっと頭のどこかで気になって過ごしづらいのですね。",
    "unsupported": false
  },
  {
    "name": "preoccupation alone does not ground daily impact",
    "users": [
      "ずっと頭のどこかで気になっています。"
    ],
    "text": "過ごしづらいのですね。",
    "unsupported": true
  },
  {
    "name": "third party state does not support user state",
    "users": [
      "同僚はずっと頭のどこかで気になって過ごしづらいです。"
    ],
    "text": "ずっと頭のどこかで気になって過ごしづらいのですね。",
    "unsupported": true
  },
  {
    "name": "own state does not support different person",
    "users": [
      "ずっと頭のどこかで気になって過ごしづらいです。"
    ],
    "text": "同僚はずっと頭のどこかで気になって過ごしづらいのですね。",
    "unsupported": true
  },
  {
    "name": "self and you canonical subject",
    "users": [
      "自分はずっと頭のどこかで気になっています。"
    ],
    "text": "あなたはずっと頭のどこかで気になっているのですね。",
    "unsupported": false
  },
  {
    "name": "latest direct denial revokes old state",
    "users": [
      "ずっと頭のどこかで気になって過ごしづらいです。",
      "今は気になっていません。過ごしづらくありません。"
    ],
    "text": "ずっと頭のどこかで気になって過ごしづらいのですね。",
    "unsupported": true
  },
  {
    "name": "true condition on the state stays hypothetical",
    "users": [
      "友人に断りたい予定があるのに、返事を先延ばしにしています。"
    ],
    "text": "もしずっと頭のどこかで気になって過ごしづらいなら、今の状況を話せます。",
    "unsupported": false
  },
  {
    "name": "known postponement antecedent is not a state condition waiver",
    "users": [
      "友人に断りたい予定があるのに、返事を先延ばしにしています。"
    ],
    "text": "返事を先延ばしにしていると、ずっと頭のどこかで気になって過ごしづらいですよね。",
    "unsupported": true
  },
  {
    "name": "faithful same-source quote retained",
    "users": [
      "同僚から「ずっと頭のどこかで気になって過ごしづらいです。」と言われました。"
    ],
    "text": "同僚から「ずっと頭のどこかで気になって過ごしづらいです。」と言われたのですね。",
    "unsupported": false
  },
  {
    "name": "AI quote is not direct user evidence",
    "users": [
      "AIから「ずっと頭のどこかで気になって過ごしづらいです。」と言われました。"
    ],
    "text": "ずっと頭のどこかで気になって過ごしづらいのですね。",
    "unsupported": true
  },
  {
    "name": "new outgoing quoted assertion is still unsupported",
    "users": [
      "友人に断りたい予定があるのに、返事を先延ばしにしています。"
    ],
    "text": "友人に「ずっと頭のどこかで気になって過ごしづらいです」と伝えてください。",
    "unsupported": true
  },
  {
    "name": "past report stays past without grounding present",
    "users": [
      "以前はずっと頭のどこかで気になっていました。"
    ],
    "text": "以前はずっと頭のどこかで気になっていたのですね。",
    "unsupported": false,
    "also": [
      {
        "text": "ずっと頭のどこかで気になっているのですね。",
        "unsupported": true
      }
    ]
  },
  {
    "name": "question and topic boundary do not create state evidence",
    "users": [
      "ずっと頭のどこかで気になって過ごしづらいです。",
      "話題を変えて、資料を直したいです。"
    ],
    "text": "ずっと頭のどこかで気になって過ごしづらいのですね。",
    "unsupported": true,
    "also": [
      {
        "users": [
          "友人に断りたい予定があるのに、返事を先延ばしにしています。"
        ],
        "text": "ずっと頭のどこかで気になっていますか？",
        "unsupported": false
      },
      {
        "users": [
          "友人に断りたい予定があるのに、返事を先延ばしにしています。"
        ],
        "text": "ずっと頭のどこかで気になっているのはなぜですか？",
        "unsupported": true
      }
    ]
  },
  { name: 'compound two-state genuine yes-no question', users: [], text: 'ずっと頭のどこかで気になって過ごしづらいですか？', unsupported: false },
  { name: 'own state after another persons quoted report remains evidence', users: ['同僚から「大丈夫」と言われましたが、私はずっと頭のどこかで気になっています。'], text: 'あなたはずっと頭のどこかで気になっているのですね。', unsupported: false },
  { name: 'quoted unmarked denial from another person cannot retract own state', users: ['私はずっと頭のどこかで気になっています。', '気になっていませんと同僚に言われました。'], text: 'あなたはずっと頭のどこかで気になっているのですね。', unsupported: false },
  {"name": "unquoted hypothetical report cannot erase later explicit own affirmation", "users": ["同僚から、もし遅れても大丈夫と言われましたが、私はずっと頭のどこかで気になっています。"], "text": "あなたはずっと頭のどこかで気になっているのですね。", "unsupported": false},
  {"name": "unquoted hypothetical report cannot erase later explicit own withdrawal", "users": ["私はずっと頭のどこかで気になっています。", "同僚から、もし遅れても大丈夫と言われましたが、今は気になっていません。"], "text": "あなたはずっと頭のどこかで気になっているのですね。", "unsupported": true},
  {"name": "actual user hypothetical state is still not affirmed evidence", "users": ["もしずっと頭のどこかで気になって過ごしづらいなら、友人に話そうと思います。"], "text": "ずっと頭のどこかで気になって過ごしづらいのですね。", "unsupported": true},
];
const actuals: unknown[] = [];
afterAll(() => { const path = process.env.ACTI_PERSISTENT_IMPACT_UNIT_OUTPUT; if (path) writeFileSync(path, JSON.stringify({ actuals }, null, 2) + '\n', {flag:'wx',mode:0o600}); });
describe('bounded persistent impact grounding', () => {
  it.each(cases)('$name', ({users,text,unsupported,also=[],remaining}) => {
    const actual = containsUnsupportedPersistentImpactPremise(text,users);
    const removal = removeUnsupportedPersistentImpactPremise(text,users);
    const subs = also.map(subpath => ({ ...subpath, users: subpath.users || users, actual: containsUnsupportedPersistentImpactPremise(subpath.text,subpath.users || users) }));
    actuals.push({users,text,expected:unsupported,actual,removal,remaining,subs});
    expect(actual).toBe(unsupported);
    if (remaining !== undefined) expect(removeUnsupportedPersistentImpactPremise(text,users)).toBe(remaining);
    if (!unsupported) expect(removeUnsupportedPersistentImpactPremise(text,users)).toBe(text);
    for (const subpath of also) expect(containsUnsupportedPersistentImpactPremise(subpath.text,subpath.users || users)).toBe(subpath.unsupported);
  });
});
