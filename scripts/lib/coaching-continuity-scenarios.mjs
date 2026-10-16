// Fixed synthetic continuity cases. These contain no customer records.
export const seededContinuityScenarios = [
  {
    "name": "seeded-apology-after-third-party-cancellation",
    "diagnosisCode": "MME-3",
    "seedHistory": [
      {
        "role": "user",
        "content": "仕事で予約の受付を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近は、どんなやり取りがありましたか？"
      },
      {
        "role": "user",
        "content": "相手から契約を解約したいという申し出がありました。"
      },
      {
        "role": "assistant",
        "content": "仕事で最後に困った場面について、誰が何を言ったか教えてください。"
      }
    ],
    "inputs": [
      {
        "content": "すみません。"
      }
    ]
  },
  {
    "name": "seeded-short-customer-service-affirmation",
    "diagnosisCode": "MME-3",
    "seedHistory": [
      {
        "role": "user",
        "content": "仕事で予約の受付を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近は、どんなやり取りがありましたか？"
      },
      {
        "role": "user",
        "content": "相手から契約を解約したいという申し出がありました。"
      },
      {
        "role": "assistant",
        "content": "接客のお仕事でしょうか？"
      }
    ],
    "inputs": [
      {
        "content": "はい、接客の仕事です。"
      }
    ]
  },
  {
    "name": "seeded-draft-after-completed-work",
    "diagnosisCode": "MME-3",
    "seedHistory": [
      {
        "role": "user",
        "content": "仕事の予定が変わり、落ち着いて対応する方法を考えたいです。"
      },
      {
        "role": "assistant",
        "content": "直近の作業ややり取りを一つずつ整理できます。"
      },
      {
        "role": "user",
        "content": "今日の準備は終わりました。"
      },
      {
        "role": "assistant",
        "content": "その後、何かやり取りはありましたか？"
      },
      {
        "role": "user",
        "content": "解約したいと相手から言われました。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "inputs": [
      {
        "content": "次回もどうぞよろしくお願いします。"
      }
    ]
  },
  {
    "name": "seeded-already-provided-cancellation-reason",
    "diagnosisCode": "MME-3",
    "seedHistory": [
      {
        "role": "user",
        "content": "仕事で予約を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近のやり取りを一つ教えてください。"
      },
      {
        "role": "user",
        "content": "引っ越しが決まったので予約をキャンセルしたいと連絡を受けました。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "inputs": [
      {
        "content": "ご希望を伺いました。"
      }
    ]
  },
  {
    "name": "seeded-explicit-topic-switch-after-opening-question",
    "diagnosisCode": "MME-3",
    "seedHistory": [
      {
        "role": "user",
        "content": "仕事で予約の受付を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近は、どんなやり取りがありましたか？"
      },
      {
        "role": "user",
        "content": "相手から契約を解約したいという申し出がありました。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "inputs": [
      {
        "content": "話題を変えて、SNSの投稿について相談したいです。"
      }
    ]
  },
  {
    "name": "seeded-actor-particle-is-not-a-reason",
    "diagnosisCode": "MME-3",
    "seedHistory": [
      {
        "role": "user",
        "content": "仕事で予約を受け付けています。"
      },
      {
        "role": "assistant",
        "content": "最近のやり取りを教えてください。"
      },
      {
        "role": "user",
        "content": "お客様から予約をキャンセルしたいと連絡がありました。"
      },
      {
        "role": "assistant",
        "content": "接客のお仕事でしょうか？"
      }
    ],
    "inputs": [
      {
        "content": "はい、接客の仕事です。"
      }
    ]
  },
  {
    "name": "seeded-separately-supplied-reason",
    "diagnosisCode": "MME-3",
    "seedHistory": [
      {
        "role": "user",
        "content": "仕事で予約を担当しています。"
      },
      {
        "role": "assistant",
        "content": "最近のやり取りを教えてください。"
      },
      {
        "role": "user",
        "content": "お客様からキャンセルの希望がありました。"
      },
      {
        "role": "assistant",
        "content": "理由について何か聞いていますか？"
      },
      {
        "role": "user",
        "content": "引っ越しが決まったそうです。"
      },
      {
        "role": "assistant",
        "content": "相手に最初に返す言葉を変えるなら、何と伝えますか？"
      }
    ],
    "inputs": [
      {
        "content": "ご希望を受け取りました。"
      }
    ]
  }
];

/** Context checks supplement the generic stream/safety checks and human review. */
export function evaluateSeededContinuityResponse(name, message) {
  if (!name.startsWith('seeded-')) return [];
  const latest = seededContinuityScenarios.find((scenario) => scenario.name === name)?.inputs[0]?.content || '';
  const latestWithoutEnding = latest.replace(/[。！？!?]+$/g, '');
  const nonEcho = (latestWithoutEnding ? message.split(latestWithoutEnding).join('') : message)
    .replace(/^[^。！？?\n]{0,80}(?:という相談ですね|についての相談ですね|の相談ですね)[。]?/u, '').trim();
  const checks = [];
  const add = (label, passed) => checks.push({ label, passed });
  add('話題に沿い汎用の作業提案へ逃げない',
    !/まだ書かれていない原因|仕事全体について結論を急がず|明日[^。！？?\n]{0,50}(?:5分|五分|ひとつだけ|一つだけ)/.test(message));
  if (name === 'seeded-explicit-topic-switch-after-opening-question') {
    add('明示された新しいSNS相談にだけ応じる',
      /SNS|投稿/.test(nonEcho) && /[？?]|書[くきい]|作[るり成]|内容|文案|目的|読者/.test(nonEcho) && !/解約|キャンセル/.test(nonEcho));
    return checks;
  }
  add('事実回答や返答案を新しい相談と決めつけない',
    !/[「『][^」』]+[」』](?:という|についての?)相談/.test(message));
  add('未提示の業務権限や処理済み事実を足さない',
    !/(?:あなた|受付担当|接客担当)[^。！？?\n]{0,18}(?:返金|解約|契約条件)[^。！？?\n]{0,12}(?:決定できます|決められます|権限があります)|(?:解約|キャンセル)(?:の)?手続き(?:は|が)(?:完了しました|済みです)|あなたの(?:役割|仕事|権限)[^。！？?\n]{0,32}(?:解約|契約)[^。！？?\n]{0,16}(?:条件|手続|返金)[^。！？?\n]{0,16}(?:決める|決定する)(?:ことです|役割です)/.test(message));
  add('直前から続く解約またはキャンセルの場面を保つ', /解約|キャンセル/.test(nonEcho) ||
    (name === 'seeded-separately-supplied-reason' && /ご希望を受け取りました/.test(message) && /言葉|案内|手続/.test(message)));
  if (name === 'seeded-draft-after-completed-work' || name === 'seeded-separately-supplied-reason') {
    add('最新の返答案を以前の作業完了報告へ戻さない',
      /言葉|返す|返答|伝え|受け取|文案|承[るっ]|表現/.test(message) && !/今日の準備は終わりました[^。！？?\n]{0,16}相談/.test(message));
  }
  if (name === 'seeded-already-provided-cancellation-reason' || name === 'seeded-separately-supplied-reason') {
    const questions = message.match(/[^。！？?\n]*(?:[？?]|(?:教えて|説明して)(?:ください|ほしいです)[。]?)/g) || [];
    add('提示済みの理由を不明と決めつけたり聞き直したりしない',
      !/理由[^。！？?\n]{0,16}(?:分から|わから|不明|未確認|まだ聞)/.test(message) &&
      !questions.some((question) => /理由|なぜ|どうして|何のため/.test(question)));
  }
  if (name === 'seeded-actor-particle-is-not-a-reason') {
    add('相手からという出所を理由の説明済みと扱わない',
      !/理由も伝えて|理由を聞いた|希望と理由を聞いた/.test(message) &&
      !(message.match(/[^。！？?\n]+[。！？?]?/g) || []).some((sentence) =>
        /理由[^。！？?\n]{0,24}(?:すでに説明|既に説明|分かって|わかって|説明済み|聞いています|伝えられています)/.test(sentence) && !/場合|なら|かどうか|[？?]/.test(sentence)));
  }
  return checks;
}
