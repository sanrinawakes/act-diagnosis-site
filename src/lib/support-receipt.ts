export function buildSupportReceiptMessage(params: {
  name: string;
  ticketId: string;
}) {
  return [
    `${params.name} 様`,
    '',
    'ACTIへお問い合わせいただき、ありがとうございます。',
    `受付番号は ${params.ticketId} です。`,
    '',
    '内容と利用状況を確認し、必要な調査・修正を進めます。',
    '内容によっては、対応完了まで2〜3日かかる場合があります。',
    '対応が完了しましたら、このメールアドレスへ改めてご連絡します。',
    '追加情報が必要な場合は、こちらからご連絡します。',
    '',
    'ACTI サポート',
  ].join('\n');
}
