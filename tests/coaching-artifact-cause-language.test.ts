import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { containsUnsupportedArtifactCauseAssertion } from '../src/lib/coaching-action-language.mjs';

// PRIVATE PREPARATION ONLY. Exact public actual; provider original unavailable.
// Original16 groups retained; local subassertions close identified implementation paths only.
const artifactCauseCases = [
  {
    "name": "exact actual public cause without supplied body",
    "userTexts": [
      "新しい企画の説明資料を作っています。",
      "対象は初めてサービスを使う人です。",
      "専門用語を減らしたいです。",
      "説明する順番にも迷っています。",
      "一枚目には利用目的を書く予定です。",
      "二枚目には利用手順を書く予定です。",
      "担当者から、資料は火曜午前10時までと言われました。",
      "今日は一枚目から直そうと思います。",
      "目的の説明が長くなりすぎています。"
    ],
    "candidate": "目的の説明が長くなっているのですね。長くなる原因は、サービスの特徴や細かいメリットを一つの文に詰め込みすぎていることにあります。\n\n一枚目の目的は「誰が・どうなるか」だけを残し、それ以外の補足説明を二枚目以降に回してください。",
    "expected": true,
    "additional": [
      {
        "candidate": "なぜサービスの特徴とメリットを一つの文に詰め込んだのですか？",
        "expected": true
      },
      {
        "candidate": "特徴やメリットを一文に詰め込んでいるため、説明が長くなっています。",
        "expected": true
      }
    ]
  },
  {
    "name": "same packing causal reason spelling",
    "userTexts": [
      "新しい企画の説明資料を作っています。",
      "対象は初めてサービスを使う人です。",
      "専門用語を減らしたいです。",
      "説明する順番にも迷っています。",
      "一枚目には利用目的を書く予定です。",
      "二枚目には利用手順を書く予定です。",
      "担当者から、資料は火曜午前10時までと言われました。",
      "今日は一枚目から直そうと思います。",
      "目的の説明が長くなりすぎています。"
    ],
    "candidate": "説明が長くなった理由は、サービスの特徴とメリットを1文に盛り込みすぎていることにあります。",
    "expected": true
  },
  {
    "name": "real condition on this structure",
    "userTexts": [
      "新しい企画の説明資料を作っています。",
      "対象は初めてサービスを使う人です。",
      "専門用語を減らしたいです。",
      "説明する順番にも迷っています。",
      "一枚目には利用目的を書く予定です。",
      "二枚目には利用手順を書く予定です。",
      "担当者から、資料は火曜午前10時までと言われました。",
      "今日は一枚目から直そうと思います。",
      "目的の説明が長くなりすぎています。"
    ],
    "candidate": "もし特徴やメリットを一文に詰め込んでいるなら、それが説明が長くなる原因かもしれません。",
    "expected": false,
    "additional": [
      {
        "candidate": "もし特徴やメリットを一文に詰め込んでいるなら見直せますが、長くなる原因は特徴やメリットを一文に詰め込んでいることにあります。",
        "expected": true
      }
    ]
  },
  {
    "name": "faithful same source reported quote with nested label",
    "userTexts": [
      "説明資料について、担当者から「長くなる原因は、サービスの『特徴』やメリットを一文に詰め込んでいることにあります」と言われました。"
    ],
    "candidate": "担当者から「長くなる原因は、サービスの『特徴』やメリットを一文に詰め込んでいることにあります」と言われたのですね。",
    "expected": false
  },
  {
    "name": "direct own current causal explanation",
    "userTexts": [
      "説明資料が長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。"
    ],
    "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
    "expected": false,
    "additional": [
      {
        "userTexts": [
          "説明資料が長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
          "訂正します。長くなる原因は、特徴やメリットを一文に詰め込んでいることかもしれません。"
        ],
        "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
        "expected": true
      },
      {
        "userTexts": [
          "新しい企画の説明資料を作っています。",
          "対象は初めてサービスを使う人です。",
          "専門用語を減らしたいです。",
          "説明する順番にも迷っています。",
          "一枚目には利用目的を書く予定です。",
          "二枚目には利用手順を書く予定です。",
          "担当者から、資料は火曜午前10時までと言われました。",
          "今日は一枚目から直そうと思います。",
          "目的の説明が長くなりすぎています。"
        ],
        "candidate": "長くなる原因は、特徴とメリットを一文に詰め込んでいることかもしれません。",
        "expected": false
      },
      {
        "userTexts": [
          "説明資料が長くなる原因は、特徴やメリットを一文に詰め込んでいることかもしれません。"
        ],
        "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
        "expected": true
      }
    ]
  },
  {
    "name": "current structure alone does not prove cause",
    "userTexts": [
      "説明資料では特徴やメリットを一文に詰め込んでいます。"
    ],
    "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
    "expected": true
  },
  {
    "name": "later own causal correction revokes evidence",
    "userTexts": [
      "説明資料が長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
      "訂正します。長くなる原因は、特徴やメリットを一文に詰め込んでいることではありません。"
    ],
    "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
    "expected": true,
    "additional": [
      {
        "userTexts": [
          "説明資料が長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
          "今は文を分けたので、一文には特徴やメリットを詰め込んでいません。"
        ],
        "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
        "expected": true
      }
    ]
  },
  {
    "name": "third party causal account does not establish own artifact",
    "userTexts": [
      "私の説明資料が長くなっています。",
      "担当者の資料が長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。"
    ],
    "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
    "expected": true
  },
  {
    "name": "AI reported causal opinion is not own causal evidence",
    "userTexts": [
      "説明資料について、AIから「長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。」と言われました。"
    ],
    "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
    "expected": true,
    "additional": [
      {
        "userTexts": [
          "説明資料が長くなる原因は特徴やメリットを一文に詰め込んでいることにあると担当者に言われました。"
        ],
        "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
        "expected": true
      }
    ]
  },
  {
    "name": "future planned packing is not established causal evidence",
    "userTexts": [
      "説明資料に、これから特徴やメリットを一文に詰め込む予定です。"
    ],
    "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
    "expected": true
  },
  {
    "name": "partial feature support cannot ground added benefits",
    "userTexts": [
      "説明資料が長くなる原因は、特徴を一文に詰め込んでいることにあります。"
    ],
    "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
    "expected": true
  },
  {
    "name": "general editorial example is not own artifact diagnosis",
    "userTexts": [
      "新しい企画の説明資料を作っています。",
      "対象は初めてサービスを使う人です。",
      "専門用語を減らしたいです。",
      "説明する順番にも迷っています。",
      "一枚目には利用目的を書く予定です。",
      "二枚目には利用手順を書く予定です。",
      "担当者から、資料は火曜午前10時までと言われました。",
      "今日は一枚目から直そうと思います。",
      "目的の説明が長くなりすぎています。"
    ],
    "candidate": "一般例として、説明が長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
    "expected": false
  },
  {
    "name": "explicit local cause denial is not an assertion",
    "userTexts": [
      "新しい企画の説明資料を作っています。",
      "対象は初めてサービスを使う人です。",
      "専門用語を減らしたいです。",
      "説明する順番にも迷っています。",
      "一枚目には利用目的を書く予定です。",
      "二枚目には利用手順を書く予定です。",
      "担当者から、資料は火曜午前10時までと言われました。",
      "今日は一枚目から直そうと思います。",
      "目的の説明が長くなりすぎています。"
    ],
    "candidate": "長くなる原因は、特徴やメリットを一文に詰め込んでいることではありません。",
    "expected": false,
    "additional": [
      {
        "candidate": "特徴を一文に詰めたことが原因とは断定できません。",
        "expected": false
      }
    ]
  },
  {
    "name": "faithful quoted report does not exempt new outside assertion",
    "userTexts": [
      "説明資料について、担当者から「長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。」と言われました。"
    ],
    "candidate": "担当者から「長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。」と言われたのですね、長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。",
    "expected": true
  },
  {
    "name": "new outbound quoted causal assertion is not a report waiver",
    "userTexts": [
      "新しい企画の説明資料を作っています。",
      "対象は初めてサービスを使う人です。",
      "専門用語を減らしたいです。",
      "説明する順番にも迷っています。",
      "一枚目には利用目的を書く予定です。",
      "二枚目には利用手順を書く予定です。",
      "担当者から、資料は火曜午前10時までと言われました。",
      "今日は一枚目から直そうと思います。",
      "目的の説明が長くなりすぎています。"
    ],
    "candidate": "担当者へ「長くなる原因は、特徴やメリットを一文に詰め込んでいることにあります。」と伝えてください。",
    "expected": true
  },
  {
    "name": "grounded single future rewrite advice stays intact",
    "userTexts": [
      "新しい企画の説明資料を作っています。",
      "対象は初めてサービスを使う人です。",
      "専門用語を減らしたいです。",
      "説明する順番にも迷っています。",
      "一枚目には利用目的を書く予定です。",
      "二枚目には利用手順を書く予定です。",
      "担当者から、資料は火曜午前10時までと言われました。",
      "今日は一枚目から直そうと思います。",
      "目的の説明が長くなりすぎています。"
    ],
    "candidate": "火曜午前10時の締切に向けて、一枚目の利用目的を「このサービスで何ができるか」が一文で伝わる形に書き直してください。",
    "expected": false
  }
];

const actuals: unknown[] = [];
afterAll(() => { const output = process.env.ACTI_ARTIFACT_CAUSE_UNIT_OUTPUT; if (output) writeFileSync(output, JSON.stringify({ scope: 'Finite artifact cause grounding controls only; no provider/network execution', actuals }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); });
describe('bounded unsupported artifact packing cause', () => {
  it.each(artifactCauseCases)('$name', ({ userTexts, candidate, expected, additional = [] }) => {
    const actual = containsUnsupportedArtifactCauseAssertion(candidate, userTexts); actuals.push({ userTexts, candidate, expected, actual }); expect(actual).toBe(expected);
    for (const subpath of additional) {
      const texts = subpath.userTexts || userTexts; const actual = containsUnsupportedArtifactCauseAssertion(subpath.candidate, texts); actuals.push({ userTexts: texts, candidate: subpath.candidate, expected: subpath.expected, actual }); expect(actual).toBe(subpath.expected);
    }
  });
});
