import { createClient } from '@supabase/supabase-js';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  })
);

const baseUrl = args.get('base') || 'https://act-diagnosis-site.vercel.app';
const mode = args.get('mode') || 'all';
const maxTotalMs = Number(args.get('max-ms') || 15000);
const maxFirstChunkMs = Number(args.get('max-first-chunk-ms') || 10000);
const expectedTextModel = args.get('expected-text-model') || '';
const vercelProtectionHeaders = {
  ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    ? {
        'x-vercel-protection-bypass':
          process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      }
    : {}),
  ...(process.env.VERCEL_OIDC_TOKEN
    ? {
        'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN,
      }
    : {}),
};

const supabase =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false } }
      )
    : null;

const shouldRunNormal = mode === 'all' || mode === 'normal';
const shouldRunLongHistory = mode === 'all' || mode === 'long';
const shouldRunConcurrency = mode === 'all' || mode === 'concurrent';
const createdEmails = [];
const results = [];

try {
  if (shouldRunNormal) {
    results.push(...(await runNormalConversation()));
  }

  if (shouldRunLongHistory) {
    results.push(await runLongHistoryConversation());
  }

  if (shouldRunConcurrency) {
    results.push(...(await runConcurrentConversations()));
  }

  assertResults(results);
  console.log(JSON.stringify({ ok: true, baseUrl, results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, baseUrl, results }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function runNormalConversation() {
  const email = uniqueEmail('normal');
  createdEmails.push(email);
  const messages = [];
  const userInputs = [
    '仕事のことで少し落ち込んでいます。短く整理を手伝ってください。',
    '上司に否定されたように感じて、次の一言が怖いです。',
    'では、明日まず何をすればいいか一つだけ教えてください。',
  ];
  const results = [];

  for (let index = 0; index < userInputs.length; index += 1) {
    messages.push({ role: 'user', content: userInputs[index] });
    const result = await sendStreamRequest({
      email,
      diagnosisCode: 'PMA-2',
      messages,
      label: `normal-${index + 1}`,
    });
    messages.push({ role: 'assistant', content: result.message });
    results.push(result);
  }

  return results;
}

async function runLongHistoryConversation() {
  const email = uniqueEmail('long-history');
  createdEmails.push(email);
  const messages = [];

  for (let index = 0; index < 218; index += 1) {
    messages.push({ role: 'user', content: buildFiller(index) });
    messages.push({
      role: 'assistant',
      content: `受け止めました。${buildFiller(index)}`,
    });
  }

  messages.push({
    role: 'user',
    content: '明日まず何をすればいいか、一つだけ短く教えてください。',
  });

  return sendStreamRequest({
    email,
    diagnosisCode: 'SMM-1',
    messages,
    label: 'long-history-437',
  });
}

async function runConcurrentConversations() {
  return Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const email = uniqueEmail(`concurrent-${index + 1}`);
      createdEmails.push(email);
      return sendStreamRequest({
        email,
        diagnosisCode: 'MME-3',
        messages: [
          {
            role: 'user',
            content: `同時接続テスト${index + 1}です。今日は少し疲れました。短く返してください。`,
          },
        ],
        label: `concurrent-${index + 1}`,
      });
    })
  );
}

async function sendStreamRequest({ email, diagnosisCode, messages, label }) {
  const body = { email, diagnosisCode, messages, stream: true };
  const payloadBytes = Buffer.byteLength(JSON.stringify(body));
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/free/chat`, {
    method: 'POST',
    headers: {
      ...vercelProtectionHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} failed ${response.status}: ${text.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error(`${label} did not return a stream body`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let message = '';
  let firstChunkMs = null;
  let doneMs = null;
  let donePayload = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const event = parseEventLine(line);
      if (!event) continue;

      if (event.type === 'chunk' && event.text) {
        firstChunkMs ??= Date.now() - startedAt;
        message += event.text;
      }

      if (event.type === 'done') {
        doneMs = Date.now() - startedAt;
        donePayload = event;
        if (event.message && event.message !== message) {
          message = event.message;
        }
      }

      if (event.type === 'error') {
        throw new Error(`${label} stream error: ${event.error || 'unknown'}`);
      }
    }
  }

  const trailingEvent = parseEventLine(buffer);
  if (trailingEvent?.type === 'done') {
    doneMs = Date.now() - startedAt;
    donePayload = trailingEvent;
    if (trailingEvent.message && trailingEvent.message !== message) {
      message = trailingEvent.message;
    }
  }

  return {
    label,
    lastUserText: messages.at(-1)?.content || '',
    status: response.status,
    inputMessages: messages.length,
    payloadBytes,
    firstChunkMs,
    doneMs,
    totalMs: Date.now() - startedAt,
    hasDone: Boolean(donePayload),
    completionStatus: donePayload?.completionStatus ?? null,
    finalizationStatus: donePayload?.finalizationStatus ?? null,
    modelName: donePayload?.modelName ?? null,
    outputChars: message.length,
    remaining: donePayload?.remaining ?? null,
    repeatsPreviousAssistant: message
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .some(
        (paragraph) =>
          paragraph.length >= 20 &&
          messages
            .filter((item) => item.role === 'assistant')
            .flatMap((item) => item.content.split(/\n{2,}/))
            .map((item) => item.trim())
            .includes(paragraph)
      ),
    userGrounding: {
      expectation: messages.some(
        (message) => message.role === 'user' && /期待|応え/.test(message.content)
      ),
      intimidation: messages.some(
        (message) => message.role === 'user' && /萎縮/.test(message.content)
      ),
      tension: messages.some(
        (message) => message.role === 'user' && /緊張/.test(message.content)
      ),
      mistake: messages.some(
        (message) => message.role === 'user' && /ミス|失敗/.test(message.content)
      ),
      anticipatedReaction: messages.some(
        (message) =>
          message.role === 'user' &&
          /反応|返事|返って|返され|返る/.test(message.content)
      ),
      hardWork: messages.some(
        (message) => message.role === 'user' && /一生懸命/.test(message.content)
      ),
      existenceRespect: messages.some(
        (message) => message.role === 'user' && /存在/.test(message.content)
      ),
      emotionalPain: messages.some(
        (message) => message.role === 'user' && /痛/.test(message.content)
      ),
      hardship: messages.some(
        (message) => message.role === 'user' && /しんどい/.test(message.content)
      ),
      pain: messages.some(
        (message) => message.role === 'user' && /つらい|辛い/.test(message.content)
      ),
      sadness: messages.some(
        (message) => message.role === 'user' && /悲し/.test(message.content)
      ),
      regret: messages.some(
        (message) => message.role === 'user' && /悔し/.test(message.content)
      ),
      heartResidue: messages.some(
        (message) => message.role === 'user' && /心残り/.test(message.content)
      ),
      malice: messages.some(
        (message) => message.role === 'user' && /悪気/.test(message.content)
      ),
      depleted: messages.some(
        (message) => message.role === 'user' && /削られ/.test(message.content)
      ),
      cherishedThoughts: messages.some(
        (message) =>
          message.role === 'user' &&
          /大切に考えていたこと|伝えたかった思い|思いが詰ま/.test(
            message.content
          )
      ),
      anxiety: messages.some(
        (message) => message.role === 'user' && /不安/.test(message.content)
      ),
      impatience: messages.some(
        (message) => message.role === 'user' && /焦り|焦っ/.test(message.content)
      ),
      loneliness: messages.some(
        (message) => message.role === 'user' && /寂し|孤独/.test(message.content)
      ),
      responsibility: messages.some(
        (message) => message.role === 'user' && /責任/.test(message.content)
      ),
      motivationalForce: messages.some(
        (message) =>
          message.role === 'user' &&
          /突き動か|バネ|原動力/.test(message.content)
      ),
      selfRegard: messages.some(
        (message) =>
          message.role === 'user' &&
          /自負|裏返し|価値あるもの/.test(message.content)
      ),
      unfairness: messages.some(
        (message) => message.role === 'user' && /不公平/.test(message.content)
      ),
      disrespect: messages.some(
        (message) =>
          message.role === 'user' &&
          /尊重されていない|軽んじられ|敬意が欠け/.test(message.content)
      ),
      wounded: messages.some(
        (message) => message.role === 'user' && /傷つ/.test(message.content)
      ),
      bracing: messages.some(
        (message) => message.role === 'user' && /身構え/.test(message.content)
      ),
      physicalFreeze: messages.some(
        (message) => message.role === 'user' && /身がすく/.test(message.content)
      ),
      prediction: messages.some(
        (message) =>
          message.role === 'user' && /予測|また.{0,12}否定/.test(message.content)
      ),
      suffering: messages.some(
        (message) =>
          message.role === 'user' && /苦し|つら|辛|しんど/.test(message.content)
      ),
      heartFatigue: messages.some(
        (message) =>
          message.role === 'user' && /疲れ|消耗/.test(message.content)
      ),
      weightMetaphor: messages.some(
        (message) =>
          message.role === 'user' && /重(?:い|たい|く)/.test(message.content)
      ),
      moodSinking: messages.some(
        (message) => message.role === 'user' && /沈ん/.test(message.content)
      ),
      emotionSwitching: messages.some(
        (message) => message.role === 'user' && /切り替え/.test(message.content)
      ),
      emphaticCause: messages.some(
        (message) =>
          message.role === 'user' && /(?:だからこそ|からこそ)/.test(message.content)
      ),
      overwhelmed: messages.some(
        (message) =>
          message.role === 'user' && /精一杯|余裕がない|限界/.test(message.content)
      ),
      energy: messages.some(
        (message) =>
          message.role === 'user' && /エネルギー|消耗/.test(message.content)
      ),
      pride: messages.some(
        (message) => message.role === 'user' && /プライド/.test(message.content)
      ),
      motivation: messages.some(
        (message) => message.role === 'user' && /意欲|やる気/.test(message.content)
      ),
      seriousness: messages.some(
        (message) => message.role === 'user' && /真剣/.test(message.content)
      ),
      perfection: messages.some(
        (message) => message.role === 'user' && /完璧/.test(message.content)
      ),
      largeBlock: messages.some(
        (message) => message.role === 'user' && /塊|壁|大きすぎ/.test(message.content)
      ),
      gap: messages.some(
        (message) =>
          message.role === 'user' && /ギャップ|実際の能力/.test(message.content)
      ),
      proving: messages.some(
        (message) =>
          message.role === 'user' && /示したい|見せたい|証明したい/.test(message.content)
      ),
    },
    message,
  };
}

function assertResults(results) {
  for (const result of results) {
    if (expectedTextModel && result.modelName !== expectedTextModel) {
      throw new Error(
        `${result.label} used ${result.modelName || 'unknown model'} instead of ${expectedTextModel}`
      );
    }
    if (!result.hasDone) {
      throw new Error(`${result.label} did not receive done event`);
    }
    if (result.completionStatus !== 'complete') {
      throw new Error(
        `${result.label} did not complete generation: ${result.completionStatus || 'missing status'}`
      );
    }
    if (result.finalizationStatus !== 'complete') {
      throw new Error(
        `${result.label} did not finalize chat metadata: ${result.finalizationStatus || 'missing status'}`
      );
    }
    if (result.firstChunkMs === null || result.firstChunkMs > maxFirstChunkMs) {
      throw new Error(
        `${result.label} first chunk too slow: ${result.firstChunkMs}ms`
      );
    }
    if (result.totalMs > maxTotalMs) {
      throw new Error(`${result.label} total too slow: ${result.totalMs}ms`);
    }
    if (/応答に時間がかかりすぎ|応答に失敗|中断しました/.test(result.message)) {
      throw new Error(`${result.label} returned fallback text`);
    }
    if (
      ['normal-3', 'long-history-437'].includes(result.label) &&
      /今できる最小の行動を一つだけ決めて/.test(result.message)
    ) {
      throw new Error(
        `${result.label} lost the conversation context: ${result.message}`
      );
    }
    if (
      requestsSingleAnswerInSmoke(result.lastUserText) &&
      !requestsExplicitClosingQuestionInSmoke(result.lastUserText) &&
      (result.message.split(/\n{2,}/).filter(Boolean).length !== 1 ||
        countCoachingActionClauses(result.message) >= 2 ||
        containsAlternativeRequestedActions(result.message) ||
        containsMultipleRequestedTargets(result.message))
    ) {
      throw new Error(
        `${result.label} returned multiple requested actions: ${result.message}`
      );
    }
    if (countSemanticQuestions(result.message) > 1) {
      throw new Error(
        `${result.label} returned multiple questions: ${result.message}`
      );
    }
    if (
      !requestsExplicitClosingQuestionInSmoke(result.lastUserText) &&
      !/手順|ステップ|順番|段階|複数|いくつか|詳しく/.test(
        result.lastUserText
      ) &&
      countCoachingMoves(result.message) > 1
    ) {
      throw new Error(
        `${result.label} returned more than one coaching move: ${result.message}`
      );
    }
    if (
      /お察し(?:いた)?します|承知(?:いた)?しました|いらっしゃる|差し支えなければ|よろしければ|(?:お聞かせ|聞かせて|教えて|お話し|話して)いただけますか|お聞かせいただけますでしょうか|させていただけますでしょうか|となっております|お伺いいたします|お気軽に(?:ご質問|お尋ね|ご相談)|頑張られ|(?:素晴らしい|大切な)一歩|大切な視点|大切な本音|本音が隠れて|気づかれたのですね|(?:提案|方法|行動)があります|それだけ[^。！？?\n]{0,80}(?:大切|重要)[^。！？?\n]{0,12}(?:から|ため)|サポートさせていただきます|ご無理なさらず|ご安心ください|お過ごしください|(?:教えて|伝えて|書いて|声をかけて|相談して|お話しして|話して)くださ(?:り|って)[、,]?ありがとうございます|(?:気持ち|状況|悩み)を言葉にしていただけて(?:よかった|うれしい)です|(?:お気持ち|気持ち).{0,8}よく(?:分|わ)かります|何か(?:具体的に|続けて)?(?:お話し|話して)(?:みたい|したい)?ことはありますか|何か[、,]?(?:今)?(?:感じていることや[、,]?)?(?:話したい|話してみたい)ことはありますか|今[、,]?(?:この瞬間に)?(?:最も|一番)?(?:話したい|話してみたい)ことは何ですか|この(?:提案|方法|考え)(?:について)?[、,]?(?:どのように|どう)(?:感じ|思い)ますか|この[^。！？?\n]{0,80}(?:いかがでしょうか|いかがですか|試せそうでしょうか|試せそうですか|できそうでしょうか|できそうですか|どう思いますか)|最後に[、,]?自分で判断を深めるための質問です|その[^。！？?\n]{0,80}気持ちが伝わります|姿勢は(?:とても)?素敵です|あなたの言葉一つ一つを大切に受け止めています|受け止めさせてください|受け止めたいと思います|細かく分析する前に|見捨てられ|承認欲求|トラウマ|幼少期|愛着障害|共依存|我慢.{0,12}証拠|という喧嘩|タタスク|タースク|タムスケジュール/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} returned overly formal coaching text: ${result.message}`
      );
    }
    if (
      /(?:一つ|ひとつ|1つ)[\s\S]{0,180}(?:例えば[\s\S]{0,100})?(?:または|あるいは|もしくは)/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} promised one option but offered alternatives: ${result.message}`
      );
    }
    if (
      /悔しさを力に変|怒りを原動力|下書きの下書き|それ以外は一旦目をつぶ|ルールを自分の中|気持ちの真ん中|心の中心|頭の中だけで整理[^。！？?\n]{0,60}余計に疲|最初の(?:1|一)?ステップだけ[^。！？?\n]{0,50}(?:\d+|一|二|三|四|五|六|七|八|九|十)分間?だけ/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} used a manually rejected coaching pattern: ${result.message}`
      );
    }
    if (
      /否定[」』]?[^。\n]{0,16}(?:ではなく|でなく)[「『]?(?:意見|別の視点|アドバイス)|(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題).{0,16}(?:横|脇)[にへ]置|(?:感情|気持ち|怖さ|不安|怒り|悲しさ|悩み|問題|課題).{0,12}切り離|客観的に(?:見|捉え|考え|整理|評価)|客観的な(?:評価|視点)/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} invalidated the user's stated feeling: ${result.message}`
      );
    }
    if (
      /(?:お気持ち|気持ち)[^。\n]{0,18}受け止めます|自分らしい/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} returned an AI posture declaration or vague standard: ${result.message}`
      );
    }
    if (
      (/期待に応え/.test(result.message) &&
        !result.userGrounding.expectation) ||
      (/萎縮/.test(result.message) && !result.userGrounding.intimidation) ||
      (/緊張/.test(result.message) && !result.userGrounding.tension) ||
      (/ミス|失敗/.test(result.message) && !result.userGrounding.mistake) ||
      (/反応が返|返事が返/.test(result.message) &&
        !result.userGrounding.anticipatedReaction) ||
      (/一生懸命/.test(result.message) && !result.userGrounding.hardWork) ||
      (/(?:責任感|責任を感じ)/.test(result.message) &&
        !result.userGrounding.responsibility) ||
      (/(?:突き動か|バネ|原動力)/.test(result.message) &&
        !result.userGrounding.motivationalForce) ||
      (/(?:自負|裏返し|価値あるもの)/.test(result.message) &&
        !result.userGrounding.selfRegard) ||
      (/(?:孤独感|孤独)/.test(result.message) &&
        !result.userGrounding.loneliness) ||
      (/(?:不公平感|不公平)/.test(result.message) &&
        !result.userGrounding.unfairness) ||
      (/(?:尊重されていない|軽んじられ|敬意が欠け)/.test(
        result.message
      ) && !result.userGrounding.disrespect) ||
      (/(?:深く.{0,16}傷つ|傷つけ)/.test(result.message) &&
        !result.userGrounding.wounded) ||
      (/(?:存在.{0,20}尊重|尊重.{0,20}存在)/.test(result.message) &&
        !result.userGrounding.existenceRespect) ||
      (/痛み/.test(result.message) && !result.userGrounding.emotionalPain) ||
      (/しんどい/.test(result.message) && !result.userGrounding.hardship) ||
      (/つらい|辛い/.test(result.message) && !result.userGrounding.pain) ||
      (/悲し/.test(result.message) && !result.userGrounding.sadness) ||
      (/悔し/.test(result.message) && !result.userGrounding.regret) ||
      (/心残り/.test(result.message) && !result.userGrounding.heartResidue) ||
      (/悪気/.test(result.message) && !result.userGrounding.malice) ||
      (/(?:時間|労力)[^。！？?\n]{0,40}削られ/.test(result.message) &&
        !result.userGrounding.depleted) ||
      (/大切に考えていたこと|伝えたかった思い|思いが詰ま/.test(
        result.message
      ) && !result.userGrounding.cherishedThoughts) ||
      (/不安/.test(result.message) && !result.userGrounding.anxiety) ||
      (/焦り|焦っ/.test(result.message) && !result.userGrounding.impatience) ||
      (/寂し/.test(result.message) && !result.userGrounding.loneliness) ||
      (/身構え/.test(result.message) && !result.userGrounding.bracing) ||
      (/身がすく/.test(result.message) &&
        !result.userGrounding.physicalFreeze) ||
      (/予測/.test(result.message) && !result.userGrounding.prediction) ||
      (/苦しめ/.test(result.message) && !result.userGrounding.suffering) ||
      (/心が疲れ|心も疲れ/.test(result.message) &&
        !result.userGrounding.heartFatigue) ||
      (/(?:お気持ち|気持ち|心)が沈/.test(result.message) &&
        !result.userGrounding.moodSinking) ||
      (/重(?:い|たい|く)/.test(result.message) &&
        !result.userGrounding.weightMetaphor) ||
      (/気持ちの切り替え/.test(result.message) &&
        !result.userGrounding.emotionSwitching) ||
      (/精一杯/.test(result.message) &&
        !result.userGrounding.overwhelmed) ||
      (/エネルギーを(?:使|消耗)/.test(result.message) &&
        !result.userGrounding.energy) ||
      (/プライド/.test(result.message) && !result.userGrounding.pride) ||
      (/意欲|やる気/.test(result.message) && !result.userGrounding.motivation) ||
      (/真剣/.test(result.message) && !result.userGrounding.seriousness) ||
      (/(?:完璧(?:主義|に|で|を)|完璧さ)/.test(result.message) &&
        !result.userGrounding.perfection) ||
      (/大きな(?:塊|壁)/.test(result.message) &&
        !result.userGrounding.largeBlock) ||
      (/ギャップ/.test(result.message) && !result.userGrounding.gap) ||
      (/(?:周囲.{0,12}(?:示したい|見せたい)|証明したい)/.test(
        result.message
      ) && !result.userGrounding.proving) ||
      (/(?:だからこそ|からこそ)/.test(result.message) &&
        !result.userGrounding.emphaticCause)
    ) {
      throw new Error(
        `${result.label} invented an unsupported psychological inference: ${result.message}`
      );
    }
    if (
      /明日/.test(result.lastUserText) &&
      /先ほど/.test(result.message)
    ) {
      throw new Error(
        `${result.label} used an inconsistent time reference: ${result.message}`
      );
    }
    if (
      /明日/.test(result.lastUserText) &&
      !/明日/.test(result.message)
    ) {
      throw new Error(
        `${result.label} dropped the requested time reference: ${result.message}`
      );
    }
    if (
      /明日の朝/.test(result.message) &&
      /[「『]明日伝えたい(?:こと|内容)[」』]/.test(result.message)
    ) {
      throw new Error(
        `${result.label} shifted tomorrow morning's action to the following day: ${result.message}`
      );
    }
    if (asksForMultipleAnswerDimensions(result.message)) {
      throw new Error(
        `${result.label} asked for multiple answer fields: ${result.message}`
      );
    }
    if (
      /次の一言が怖/.test(result.lastUserText) &&
      /(?:上司|相手)から[^。！？?\n]{0,100}(?:返って|言われ|言葉)/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} confused the user's next words with the other person's reply: ${result.message}`
      );
    }
    if (
      (/[「『]今日確認したいこと[」』]/.test(result.message) ||
        /確認したい(?:こと|ポイント|内容)[^。！？\n]{0,40}(?:メモ|書き出)/.test(
          result.message
        )) &&
      !/確認/.test(result.lastUserText)
    ) {
      throw new Error(
        `${result.label} invented a vague confirmation task: ${result.message}`
      );
    }
    if (
      /業務の確認だけ|[「『]?事実[」』]?だけ|話すのは[^。！？\n]{0,30}だけにする|(?:話題|会話)[^。！？\n]{0,16}(?:避け|限定)|(?:今日|前回)[^。！？\n]{0,24}(?:言われた|話した|起きた)こととは関係のない/.test(
        result.message
      ) &&
      !/業務の確認だけ|事実[^。！？\n]{0,8}だけ|だけにする|避け|限定|(?:今日|前回)[^。！？\n]{0,24}(?:言われた|話した|起きた)こととは関係のない/.test(
        result.lastUserText
      )
    ) {
      throw new Error(
        `${result.label} added an unsupported conversation restriction: ${result.message}`
      );
    }
    if (/\*\*|^#{1,6}\s/m.test(result.message)) {
      throw new Error(
        `${result.label} returned Markdown decoration: ${result.message}`
      );
    }
    if (
      requestsSingleAnswerInSmoke(result.lastUserText) &&
      /例[:：][^。！？\n]{1,100}(?:、|または|もしくは|など)|例えば[、,]?[^。！？\n]{1,100}(?:または|もしくは|(?:、[^。！？\n]{1,80})+など)/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} mixed multiple examples into one answer: ${result.message}`
      );
    }
    if (
      /(?:タイミング|時機)[^。！？?\n]{0,24}(?:や|と)[^。！？?\n]{0,24}(?:言い方|言葉)|(?:言い方|言葉)[^。！？?\n]{0,24}(?:や|と)[^。！？?\n]{0,24}(?:タイミング|時機)/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} asked for timing and wording together: ${result.message}`
      );
    }
    if (!hasBalancedJapaneseDelimiters(result.message)) {
      throw new Error(
        `${result.label} returned unbalanced Japanese delimiters: ${result.message}`
      );
    }
    if (result.repeatsPreviousAssistant) {
      throw new Error(
        `${result.label} repeated a previous assistant paragraph: ${result.message}`
      );
    }
    if (
      !requestsExplicitClosingQuestionInSmoke(result.lastUserText) &&
      hasStandaloneSuggestedWordingAndQuestion(result.message)
    ) {
      throw new Error(
        `${result.label} combined suggested wording with an extra question: ${result.message}`
      );
    }
    if (
      result.label === 'long-history-437' &&
      !(
        /SNS|投稿|発信|仕事|職場|タスク/.test(result.message) &&
        /書|投稿|発信|メモ|資料|タスク|予定|着手|連絡|相談|伝|確認|整理/.test(
          result.message
        )
      )
    ) {
      throw new Error(
        `${result.label} returned an action unrelated to its history: ${result.message}`
      );
    }
    if (
      result.label === 'long-history-437' &&
      /(?:SNSの)?アプリ.{0,32}(?:見えない|隠|移動|削除|閉じ)|通知.{0,16}(?:切|オフ)/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} reinforced SNS avoidance: ${result.message}`
      );
    }
    if (
      /率直な状況|今の自分の(?:率直な)?状況|事実として一言|自分の本音を一言|心が引っかかって|気にかかっている|引っかかっている(?:出来事|状況)/.test(
        result.message
      )
    ) {
      throw new Error(
        `${result.label} returned a vague action: ${result.message}`
      );
    }
  }
}

function countCoachingActionClauses(text) {
  const actionPattern =
    /書き出|書い|書く|抜き出|箇条書|決め|選ん|伝えて|話し始め|話して|話しかけ|(?:口|声)に出|読み上げ|読み返|見直|繰り返|深呼吸|呼吸を|飲ん|飲む|淹れ|意識を向け|感じる|思い浮かべ|休ん|休息|横にな|閉じ|眺め|確認|開い|移動|入れ|向か|座っ|席につ|立ち上が|歩い|片付|準備|通知.{0,6}オフ|送っ|連絡|相談|断っ|置い|取り組|始め/g;
  const unquoted = stripJapaneseQuotedContent(text).replace(
    /(?:話す|話し始める|話しかける)直前に[、,]?/g,
    ''
  );
  const lexicalCount = unquoted
    .split(/(?:て|で)から|その後|次に|続いて|[、,]/)
    .map((clause) => clause.trim())
    .reduce(
      (total, clause) => total + (clause.match(actionPattern) || []).length,
      0
    );
  const chainedActions = (
    unquoted.match(
      /(?:て|で)から|(?:した|いた|いだ|んだ|った)後(?:で|に)?|(?:(?<!と)(?:し|して)|いて|いで|んで|って)[、,]/g
    ) || []
  ).length;
  const hasDirective =
    /(?:て|で)(?:ください|みてください|みましょう)|してください|しましょう/.test(
      unquoted
    );

  return Math.max(
    lexicalCount,
    hasDirective && chainedActions > 0 ? chainedActions + 1 : 0
  );
}

function asksForMultipleAnswerDimensions(text) {
  const segments = text.match(/[^。！？?\n]+[。！？?]?|\n+/g) || [];
  return segments.some((segment) => {
    const trimmed = segment.trim();
    const isQuestion =
      /[？?]/.test(trimmed) ||
      /(?:です|ます|でしょう|ません)か[。]?$/.test(trimmed) ||
      /(?:教えて|聞かせて|答えて|話して)(?:ください|もらえますか)[。]?$/.test(
        trimmed
      );
    return (
      isQuestion &&
      (/(?:一つずつ|それぞれ)[^。！？?\n]{0,40}(?:聞かせ|教えて|答えて)/.test(
        trimmed
      ) ||
        /(?:それとも|または|あるいは)/.test(trimmed) ||
        /[「『][^」』]{1,50}[」』](?:と|か)[「『][^」』]{1,50}[」』]のどちら/.test(
          trimmed
        ) ||
        /(?:です|ます)か[、,]?(?:それとも|または|あるいは)[^。！？?\n]{1,100}(?:です|ます)か/.test(
          trimmed
        ) ||
        /(?:出来事|事実|状況|理由|原因|気持ち|感情|思い|希望|望み|行動|タイミング|言い方|方法|内容|テーマ|気になっていること|頭に浮かんでくること)[」』]?(?:と|や|および|ならびに|、)[^。！？?\n]{0,32}[「『]?(?:出来事|事実|状況|理由|原因|気持ち|感情|思い|希望|望み|行動|タイミング|言い方|方法|内容|テーマ|気になっていること|頭に浮かんでくること)/.test(
          trimmed
        ))
    );
  });
}

function hasStandaloneSuggestedWordingAndQuestion(text) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return (
    paragraphs.some((paragraph) =>
      /^(?:例えば[、,]?\s*)?「[^」]{8,}」(?:と[^。！？?\n]{0,30})?[。！]?$/.test(
        paragraph
      )
    ) &&
    countSemanticQuestions(text) > 0
  );
}

function countSemanticQuestions(text) {
  const unquoted = stripJapaneseQuotedContent(text);
  const segments = unquoted.match(/[^。！？?\n]+[。！？?]?|\n+/g) || [];
  return segments.reduce((total, segment) => {
    const trimmed = segment.trim();
    const isQuestion =
      /[？?]/.test(trimmed) ||
      /(?:です|ます|でしょう|ません)か[。]?$/.test(trimmed) ||
      /(?:教えて|聞かせて|答えて|話して)(?:ください|もらえますか)[。]?$/.test(
        trimmed
      );
    return total + (isQuestion ? 1 : 0);
  }, 0);
}

function countCoachingMoves(text) {
  const quotedWordingMoves = (
    text.match(
      /「[^」]{4,}(?:お願い|してほしい|話したい|伝えたい|聞いてほしい|できる[？?]|ませんか)[^」]*」/g
    ) || []
  ).length;
  const unquoted = stripJapaneseQuotedContent(text);
  const segments = unquoted.match(/[^。！？?\n]+[。！？?]?|\n+/g) || [];
  return quotedWordingMoves + segments.reduce((total, segment) => {
    const trimmed = segment.trim();
    if (!trimmed) return total;
    const isQuestion =
      /[？?]/.test(trimmed) ||
      /(?:です|ます|でしょう|ません)か[。]?$/.test(trimmed) ||
      /(?:教えて|聞かせて|答えて|話して)(?:ください|もらえますか)[。]?$/.test(
        trimmed
      );
    const isDirective = /(?:ください|ましょう)[。！]?$/.test(trimmed);
    return total + (isQuestion || isDirective ? 1 : 0);
  }, 0);
}

function containsAlternativeRequestedActions(text) {
  if (
    /[「『][^」』]{1,100}[」』](?:や|または|もしくは|あるいは)[「『][^」』]{1,100}[」』]/.test(
      text
    )
  ) {
    return true;
  }

  if (/（[^）]+(?:、|または|もしくは)[^）]+など）/.test(text)) {
    return true;
  }

  return /(?:する|して|書く|書いて|伝える|話す|休む|閉じる|移動させる|オフにする|設定する|行う)か[、,]|(?:または|もしくは|あるいは)/.test(
    stripJapaneseQuotedContent(text)
  );
}

function containsMultipleRequestedTargets(text) {
  return /(?:気持ち|感じたこと|伝えたいこと|気になっていること|出来事|状況|内容|言葉|一言|行動|作業|仕事|テーマ|頭に浮かんでくること)[^。！？\n]{0,12}(?:や|または|もしくは)[^。！？\n]{0,30}(?:気持ち|感じたこと|伝えたいこと|気になっていること|出来事|状況|内容|言葉|一言|行動|作業|仕事|テーマ|頭に浮かんでくること)/.test(
    text
  );
}

function stripJapaneseQuotedContent(text) {
  return text.replace(/「[^」]*」|『[^』]*』/g, '');
}

function hasBalancedJapaneseDelimiters(text) {
  return [
    ['「', '」'],
    ['『', '』'],
    ['（', '）'],
  ].every(
    ([open, close]) =>
      text.split(open).length - 1 === text.split(close).length - 1
  );
}

function requestsSingleAnswerInSmoke(text) {
  return /(?:(?:一つ|ひとつ|1つ)(?:だけ)?.{0,24}(?:教|提案|答|挙|示|伝|お願)|(?:教|提案|答|挙|示|伝|お願).{0,24}(?:一つ|ひとつ|1つ)(?:だけ)?|一言(?:だけ|で)|最初の一言|質問(?:は|を)?(?:なし|不要|しない)|短く(?:答|教|返))/.test(
    text
  );
}

function requestsExplicitClosingQuestionInSmoke(text) {
  if (
    /質問(?:は|を)?(?:なし|不要|しない|せず)|質問を付けない|質問で終わらない/.test(
      text
    )
  ) {
    return false;
  }

  return /(?:最後|末尾|終わり|締め).{0,40}質問|質問(?:を|は)?[^。！？?\n]{0,20}(?:一つ|ひとつ|1つ)(?:だけ)?[^。！？?\n]{0,12}(?:して|付け|添え|ください|お願い)/.test(
    text
  );
}

async function cleanup() {
  if (!supabase || createdEmails.length === 0) return;

  const { error } = await supabase
    .from('free_users')
    .delete()
    .in('email', createdEmails);

  if (error) {
    console.error(`Failed to delete smoke test users: ${error.message}`);
  }
}

function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function uniqueEmail(prefix) {
  return `codex-smoke-${prefix}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}@example.com`;
}

function buildFiller(index) {
  return `これは長い履歴テスト用のダミー文です ${index}。仕事の悩み、人間関係、SNSへの抵抗感、明日の一歩について相談しています。`.repeat(
    10
  );
}
