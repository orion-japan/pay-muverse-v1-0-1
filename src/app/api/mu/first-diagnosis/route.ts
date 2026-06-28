export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  normalizeAuthz,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';
import {
  enforceImaginalCopyFromIntention,
  type ImaginalIntentionLayer,
} from '@/lib/iros/imaginal/imaginalCopySeed';
import {
  applyImaginalFlowSeed,
  type ImaginalFlowSeedLike,
} from '@/lib/iros/imaginal/imaginalFlowSeed';

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

type ImaginalCoreSeed = {
  current_future_imaginal?: string;
  current_future_meaning?: string;
  current_state_from_future?: string;
  current_word_reaction?: string;
  current_action_reaction?: string;
  shifted_future_imaginal?: string;
  shifted_future_meaning?: string;
  shifted_state_from_future?: string;
  shifted_word_direction?: string;
  shifted_action_direction?: string;
  evidence_bridge?: string;
  current_interpretation?: string;
  future_imaginal_image?: string;
  copy_material?: string;
  copy_tone?: string;
  copy_direction?: string;
  copy_ng?: string;
  undesired_future?: string;
  avoidance_wish?: string;
  word_from_undesired_future?: string;
  action_from_undesired_future?: string;
  creative_future?: string;
  creative_word_direction?: string;
};

type ImaginalDiagnosisSeed = ImaginalFlowSeedLike & {
  kind?: 'imaginal_first';
  imaginal_copy?: string;
  visible_wish?: string;
  seen_future?: string;
  word_reaction?: string;
  action_reaction?: string;
  intention_layer?: ImaginalIntentionLayer;
  imaginal_core_seed?: ImaginalCoreSeed;
  dominant_field?: 'anxiety' | 'comparison' | 'destruction' | 'creation' | 'unknown';
  creative_direction?: string;
  today_step?: string;
  image_type?:
    | 'line_or_dm'
    | 'email'
    | 'memo'
    | 'todo'
    | 'post_draft'
    | 'book_page'
    | 'application_page'
    | 'other';
  evidence_points?: string[];
  uncertain_points?: string[];
  user_name_candidate?: string;
  writer_directives?: string[];
};

function json(data: unknown, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

function normalizeDataUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim();
  if (!v.startsWith('data:image/')) return null;
  if (!v.includes(';base64,')) return null;
  return v;
}

function cleanString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const s = value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .join('、');
    return s || undefined;
  }

  const s = String(value ?? '').trim();
  return s || undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return items.length ? items : undefined;
}

function normalizeDominantField(value: unknown): ImaginalDiagnosisSeed['dominant_field'] {
  const v = String(value ?? '').trim();
  if (v === 'anxiety' || v === 'comparison' || v === 'destruction' || v === 'creation') return v;
  return 'unknown';
}

function normalizeImageType(value: unknown): ImaginalDiagnosisSeed['image_type'] {
  const v = String(value ?? '').trim();
  if (
    v === 'line_or_dm' ||
    v === 'email' ||
    v === 'memo' ||
    v === 'todo' ||
    v === 'post_draft' ||
    v === 'book_page' ||
    v === 'application_page' ||
    v === 'other'
  ) {
    return v;
  }
  return 'other';
}

function normalizeIntentionLayer(value: unknown): ImaginalIntentionLayer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;

  const layer: ImaginalIntentionLayer = {
    received_meaning: cleanString(v.received_meaning ?? v.receivedMeaning),
    seen_future: cleanString(v.seen_future ?? v.seenFuture),
    hidden_intention: cleanString(v.hidden_intention ?? v.hiddenIntention),
    future_distortion: cleanString(v.future_distortion ?? v.futureDistortion),
  };

  return Object.values(layer).some(Boolean) ? layer : undefined;
}

function normalizeImaginalCoreSeed(value: unknown): ImaginalCoreSeed | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const seed: ImaginalCoreSeed = {
    current_future_imaginal: cleanString(v.current_future_imaginal ?? v.currentFutureImaginal),
    current_future_meaning: cleanString(v.current_future_meaning ?? v.currentFutureMeaning),
    current_state_from_future: cleanString(v.current_state_from_future ?? v.currentStateFromFuture),
    current_word_reaction: cleanString(v.current_word_reaction ?? v.currentWordReaction),
    current_action_reaction: cleanString(v.current_action_reaction ?? v.currentActionReaction),
    shifted_future_imaginal: cleanString(v.shifted_future_imaginal ?? v.shiftedFutureImaginal),
    shifted_future_meaning: cleanString(v.shifted_future_meaning ?? v.shiftedFutureMeaning),
    shifted_state_from_future: cleanString(v.shifted_state_from_future ?? v.shiftedStateFromFuture),
    shifted_word_direction: cleanString(v.shifted_word_direction ?? v.shiftedWordDirection),
    shifted_action_direction: cleanString(v.shifted_action_direction ?? v.shiftedActionDirection),
    evidence_bridge: cleanString(v.evidence_bridge ?? v.evidenceBridge),
    current_interpretation: cleanString(v.current_interpretation ?? v.currentInterpretation),
    future_imaginal_image: cleanString(v.future_imaginal_image ?? v.futureImaginalImage),
    copy_material: cleanString(v.copy_material ?? v.copyMaterial),
    copy_tone: cleanString(v.copy_tone ?? v.copyTone),
    copy_direction: cleanString(v.copy_direction ?? v.copyDirection),
    copy_ng: cleanString(v.copy_ng ?? v.copyNg),
    undesired_future: cleanString(v.undesired_future ?? v.undesiredFuture),
    avoidance_wish: cleanString(v.avoidance_wish ?? v.avoidanceWish),
    word_from_undesired_future: cleanString(v.word_from_undesired_future ?? v.wordFromUndesiredFuture),
    action_from_undesired_future: cleanString(v.action_from_undesired_future ?? v.actionFromUndesiredFuture),
    creative_future: cleanString(v.creative_future ?? v.creativeFuture),
    creative_word_direction: cleanString(v.creative_word_direction ?? v.creativeWordDirection),
  };
  return Object.values(seed).some(Boolean) ? seed : undefined;
}

function normalizeDiagnosisScope(value: unknown): ImaginalDiagnosisSeed['diagnosis_scope'] | undefined {
  return String(value ?? '').trim() === 'current_imaginal' ? 'current_imaginal' : undefined;
}

function normalizeFlowPriority(value: unknown): true | undefined {
  return value === true || String(value ?? '').trim() === 'true' ? true : undefined;
}

function buildDisplayText(seed: ImaginalDiagnosisSeed, fallback: string): string {
  const copy = cleanString(seed.imaginal_copy);
  if (!copy) return fallback;
  const core = seed.imaginal_core_seed;

  return [
    'あなたのイマジナルコピー',
    copy,
    '',
    'いま見えている願い',
    cleanString(core?.current_state_from_future) || cleanString(core?.avoidance_wish) || cleanString(seed.visible_wish) || 'いま見ている未来を止めるために、安心できる反応を求めている状態を読んでいます。',
    '',
    '見続けている未来',
    cleanString(core?.current_future_imaginal) || cleanString(core?.undesired_future) || cleanString(seed.seen_future) || '思い通りにならず、また待つ側に残されるように感じる未来を見ている可能性があります。',
    '',
    '言葉に出ている反応',
    cleanString(core?.current_word_reaction) || cleanString(core?.word_from_undesired_future) || cleanString(seed.word_reaction) || 'その未来を止めたい確認の言葉が出ています。',
    '',
    '行動に出ている反応',
    cleanString(core?.current_action_reaction) || cleanString(core?.action_from_undesired_future) || cleanString(seed.action_reaction) || 'その未来を止めたい焦りが、行動の速度に出ています。',
    '',
    '創造の方向',
    cleanString(core?.shifted_future_imaginal) || cleanString(core?.creative_future) || cleanString(seed.creative_direction) || '未来のイマジナルを安心してつながっている方向へ置き直すことです。',
    '',
    '今日の小さな一歩',
    cleanString(core?.shifted_word_direction) || cleanString(core?.creative_word_direction) || cleanString(seed.today_step) || '変えた未来のイマジナルから、一言と行動を選んでください。',
    '',
    'これは、画像をきっかけに見えた「今現在のイマジナル」です。',
  ].join('\n');
}

function safeParseDiagnosis(raw: string): {
  displayText: string;
  seed: ImaginalDiagnosisSeed | null;
} {
  const fallback = { displayText: raw, seed: null };

  try {
    const parsed = JSON.parse(raw.trim());
    const seedRaw = parsed?.seed && typeof parsed.seed === 'object' && !Array.isArray(parsed.seed)
      ? parsed.seed
      : parsed;

    const coreSeed = normalizeImaginalCoreSeed(seedRaw?.imaginal_core_seed ?? seedRaw?.imaginalCoreSeed);

    const seed: ImaginalDiagnosisSeed = {
      kind: 'imaginal_first',
      imaginal_copy: cleanString(seedRaw?.imaginal_copy ?? seedRaw?.imaginalCopy),
      visible_wish: cleanString(seedRaw?.visible_wish ?? seedRaw?.visibleWish),
      seen_future: cleanString(seedRaw?.seen_future ?? seedRaw?.seenFuture),
      word_reaction: cleanString(seedRaw?.word_reaction ?? seedRaw?.wordReaction),
      action_reaction: cleanString(seedRaw?.action_reaction ?? seedRaw?.actionReaction),
      intention_layer: normalizeIntentionLayer(seedRaw?.intention_layer ?? seedRaw?.intentionLayer),
      imaginal_core_seed: coreSeed,
      diagnosis_scope: normalizeDiagnosisScope(seedRaw?.diagnosis_scope ?? seedRaw?.diagnosisScope),
      flow_priority: normalizeFlowPriority(seedRaw?.flow_priority ?? seedRaw?.flowPriority),
      image_seed: seedRaw?.image_seed ?? seedRaw?.imageSeed,
      current_flow_input_seed: seedRaw?.current_flow_input_seed ?? seedRaw?.currentFlowInputSeed,
      second_flow_input_seed: seedRaw?.second_flow_input_seed ?? seedRaw?.secondFlowInputSeed,
      dominant_field: normalizeDominantField(seedRaw?.dominant_field ?? seedRaw?.dominantField),
      creative_direction: cleanString(seedRaw?.creative_direction ?? seedRaw?.creativeDirection),
      today_step: cleanString(seedRaw?.today_step ?? seedRaw?.todayStep),
      image_type: normalizeImageType(seedRaw?.image_type ?? seedRaw?.imageType),
      evidence_points: cleanStringArray(seedRaw?.evidence_points ?? seedRaw?.evidencePoints),
      uncertain_points: cleanStringArray(seedRaw?.uncertain_points ?? seedRaw?.uncertainPoints),
      user_name_candidate: cleanString(seedRaw?.user_name_candidate ?? seedRaw?.userNameCandidate) || '',
      writer_directives: [
        'Mu文体で返す',
        '説明調にしない',
        '相手の気持ちは断定しない',
        '画像は補助として扱う',
        '現在状態ではなく未来のイマジナルを正本にする',
        '今は未来のイマジナルの結果として説明する',
        '未来のイマジナルを変えると今の言葉と行動が変わる構造で返す',
        'コピーはcurrent_future_imaginalからLLMが作る入口として扱う',
        '本質はimaginal_core_seedを正本にして説明欄で渡す',
      ],
    };

    Object.assign(seed, applyImaginalFlowSeed(seed));

    const enforcedSeed = enforceImaginalCopyFromIntention(seed);
    seed.imaginal_copy = enforcedSeed.imaginal_copy;
    seed.seen_future = enforcedSeed.seen_future;
    seed.intention_layer = enforcedSeed.intention_layer;

    const displayText = buildDisplayText(seed, raw);

    return { displayText, seed };
  } catch {
    return fallback;
  }
}

function normalizeWriterDisplayText(value: unknown, fallback: string): string {
  const text = cleanString(value);
  const base = text || fallback;
  const note = 'これは、画像をきっかけに見えた「今現在のイマジナル」です。';
  const withoutNote = base
    .replace(/注意書き\s*[:：]?\s*/gu, '')
    .replace(/注意\s*[:：].*?(?=\n\n|\nこれは、画像をきっかけに見えた|$)/gsu, '')
    .replace(/ここに書かれたのは、画像をきっかけに立ち上がっている流れとして見えたもので、相手の状況や意図を断定するものではありません。\s*/gu, '')
    .replace(/これは、画像をきっかけに見えた「今現在のイマジナル」です。\s*/gu, '')
    .trim();
  return [withoutNote, note].filter(Boolean).join('\n\n').trim();
}

async function writeDiagnosisFromSeed(params: {
  apiKey: string;
  model: string;
  seed: ImaginalDiagnosisSeed | null;
  fallback: string;
}): Promise<string> {
  const { apiKey, model, seed, fallback } = params;
  if (!seed?.imaginal_flow_seed) return normalizeWriterDisplayText(fallback, fallback);

  const writerModel = process.env.MU_FIRST_DIAGNOSIS_WRITER_MODEL || model;
  const writerSystem = [
    'あなたはMuverseの初回イマジナル診断のWriterです。',
    '前段の画像観測とフロー判定Seedだけを正本にして、ユーザー表示用の診断文を書いてください。',
    '現在状態の説明を正本にしないでください。正本は、現在を生んでいる未来のイマジナルと、変えた先の未来のイマジナルです。',
    '画像を新しく読み直さないでください。意味を追加せず、渡されたSeedから自然な日本語にしてください。',
    'もっとも重要な正本は seed.imaginal_core_seed です。current_future_imaginal / current_future_meaning / shifted_future_imaginal / shifted_future_meaning を最優先してください。',
    '基本構造は「今この未来のイマジナルを見ている。だから今こうなっている。でも未来のイマジナルをこう変えると、今こう変わる」です。',
    '「いま見えている願い」は、現在の感情説明ではなく、current_future_imaginal を見ているから起きている願いとして書いてください。',
    '「いま見えている願い」では、「相手に優先されたい」「約束を守ってほしい」と要求のように並べないでください。中心は「大切にされている安心をもう一度感じたい」「関係の中に自分の居場所があると確かめたい」です。',
    '「見続けている未来」には、current_future_imaginal と current_future_meaning を書き、その先にある怖さまで書いてください。画面上の状態説明で止めないでください。',
    '「見続けている未来」には、期待が消えるだけで止めず、「自分は重要ではない」「取り残される」「もう会えなくなる」「関係から外される」など、その先にある怖さまで表現してください。',
    '「一度の不履行が自分の価値を下げる」「価値が下がる」という表現は使わないでください。出来事が人の価値を下げるのではなく、「大切にされていないように感じる」「関係の外に置かれていくように感じる」と表現してください。',
    'コピーにも、current_future_imaginal の先にある怖さを入れてください。単なる期待や待ち合わせではなく、取り残される・重要ではない・会えなくなる恐れが伝わる比喩にしてください。',
    'コピーでは、小舟・岸・潮・灯台・ベル・通知・窓・チケット・待合室などの物体比喩に逃げないでください。',
    'コピーは、3番の「見続けている未来」にある関係の未来そのものから作ってください。例: 関係の外に置かれる、もう会えなくなる、優先度から消える、期待していた場所から外される。',
    'コピーは前回の診断文脈に引きずられないでください。画像ごとに、ユーザー側発言の中心から作り直してください。',
    '右側ユーザー発言の中心が「救えたのか」「役に立てたのか」「自分の存在に意味があったのか」の確認なら、コピーもその未来から作ってください。例: 「救えた実感を探す私」「届いた影響を確かめたい私」「役に立てたことを信じきれない私」。',
    '右側ユーザー発言に「僕がいなくても」「救われないと」「ほんとに？」「たいしたことしてない」がある場合、中心テーマは priority_abandonment ではなく rescue_impact としてください。コピー、願い、未来、言葉、行動は「救えた実感を受け取れない」「役に立てたことを確かめたい」「感謝を受け取る前に確認してしまう」方向で作ってください。',
    'このケースでは「今回の中心テーマから外れたコピー」「関係の外に置かれる未来」「もう会えなくなる予定」などへ寄せないでください。',
    'このケースで放置・優先順位のコピーへ安易に寄せないでください。それは相手に放置される文脈のコピーであり、今回の右側ユーザー発言の中心とは限りません。',
    '良いコピー例はテーマ別にしてください。rescue_impact なら「救えた実感を探す私」「届いた影響を確かめたい私」「役に立てたことを信じきれない私」。priority_abandonment なら「優先順位から消えていく私」「関係の外に置かれる未来」。ただし priority_abandonment は右側ユーザー発言に明確な根拠がある場合だけ使ってください。',
    'コピーでは「予感」を多用しないでください。弱く説明的になります。未来の絵がそのまま立ち上がる短い言葉にしてください。ただし、前回のコピーや汎用テンプレに引っ張られず、今回の右側ユーザー発言の中心テーマから作ってください。',
    '悪いコピー例: 「岸に残された小舟」「約束の潮に残された小舟」「ベルだけ鳴る灯台」「待合室のチケット」。これは物体比喩に逃げていて、3番の未来そのものではありません。',
    '「言葉に出ている反応」には、current_word_reaction をそのまま羅列しないでください。「その未来を見ているため、不安や恐怖を安心で確かめる言葉になっている。相手には責められているように届きやすい」という構造で説明してください。',
    '「責めている」「自責を引き出そうとしている」「相手を動かそうとしている」と断定しないでください。代わりに「相手には責められているように届きやすい」「自責を求められているように感じられやすい」と書いてください。',
    '本人の意図を悪く見せないでください。本当は安心したい、不安をほどきたい、つながりを確かめたい動きとして書いてください。',
    '「行動に出ている反応」には、current_action_reaction を現状の羅列として出さないでください。「未来の不安を希望に変えたい行動が出ているが、相手からは批判や圧として受け取られやすい」という構造で説明してください。',
    '「創造の方向」には、shifted_future_imaginal と shifted_future_meaning を書いてください。小さな約束が積み重なる未来や相手が連絡する未来を中心にしないでください。中心は、連絡が来る来ないにかかわらず自分の安心を保てる基盤を作る未来です。',
    '「創造の方向」には、そのためにどうするかも短く入れてください。例: 相手の反応を安心の条件にしない、まず自分の時間へ戻る、責める確認ではなく安心を前提にした一言にする。',
    '「創造の方向」では、「相手の反応が私の価値を決めない」ではなく、「相手の反応だけで私の安心を決めなくていい」という方向で書いてください。',
    '「今日の小さな一歩」には、この話題の予定調整や会う提案を書かないでください。未来の創造の実践を書いてください。例: 怖い未来を一度書き出し、安心している未来を一文で置き直し、その未来から短い一言だけ作ってから自分の行動へ戻る。',
    '「今日の小さな一歩」には、相手に何かを守らせる手順ではなく、自分が未来のイマジナルを置き直す実践を出してください。',
    'コピーはSeedではありません。コピーはLLMの仕事です。current_future_imaginal と copy_tone から、短く少し愉快な入口コピーを作ってください。',
    '表示順では「あなたのイマジナルコピー」を1番に置いてください。ただし、生成順ではコピーを先に作らないでください。',
    '内部では必ず先に「見続けている未来」を深く作り、その未来の一番象徴的な絵を取り出してから、最後にイマジナルコピーを作ってください。',
    'つまり、生成順は「見続けている未来」→「その先の怖さ」→「象徴的な一枚絵」→「コピー」、表示順は「コピー」→「願い」→「見続けている未来」です。',
    'コピーは現在状態のラベルではなく、今見ている未来のイマジナル像にしてください。',
    '「こう思っているから、この未来を見ている」という流れを、短い比喩にしてください。',
    'あなたのイマジナルコピーは、12〜24文字程度。長い分析文、因果説明、括弧補足、現在状態ラベルは禁止です。',
    '「ベル」「通知」「灯りだけ」「待機中」「開店中」「保留中」「レンタル中」のような画面上・現在状態ラベルは禁止です。',
    '良いコピー例: 「置いてけぼりの一羽アヒル」「岸に残された小舟」「改札前の迷子チケット」。',
    '悪いコピー例: 「期待がこぼれる小さな待ち合わせ」「ベルだけ鳴る小さな灯台ひとつ」「置いてけぼり待機、開店中」「既読レンタル中、返事保留」。これは画面上・現在状態、または恐れの先が浅いコピーなので禁止です。',
    '注意書きの見出しや追加説明は出さないでください。最後の1行だけを固定文にしてください。',
    '最後の1行は必ず「これは、画像をきっかけに見えた「今現在のイマジナル」です。」にしてください。',
    '「画像の内容そのものではなく、いま立ち上がっているフローをもとに見ています。」は出さないでください。',
    '相手の気持ち、未来、運命、人格を断定しないでください。',
    '「寄り添います」「静かに」「本当の自分」「本当の姿」「言葉になる前」は使わないでください。',
    '出力はJSONのみ。display_text だけを持つオブジェクトにしてください。',
    'display_textには内部キー名、currentFlow、secondFlow、Seed、JSON、imaginal_core_seedという言葉を出さないでください。',
    '構成は、1.あなたのイマジナルコピー 2.いま見えている願い 3.見続けている未来 4.言葉に出ている反応 5.行動に出ている反応 6.創造の方向 7.今日の小さな一歩。最後に固定文を1行だけ置いてください。',
    '全体で900文字以内。',
  ].join('\n');

  const writerSeed: ImaginalDiagnosisSeed = { ...seed };
  delete writerSeed.imaginal_copy;
  const writerUser = [
    '以下のSeedを正本にして、初回イマジナル診断の表示文だけを作ってください。',
    'LINE/DM/チャット画像では、右側・緑色の吹き出しがユーザー本人、左側・白色の吹き出しが相手です。診断対象は必ずユーザー本人だけにしてください。',
    '上部に表示されている名前は相手名として扱い、ユーザー名として扱わないでください。',
    '左側の相手の言葉は文脈としてだけ使い、相手の願い・不安・未来を診断しないでください。',
    'コピー、願い、見続けている未来、言葉、行動、創造の方向は、すべて右側・緑色のユーザー発言から見えるイマジナルを中心にしてください。',
    '右側のユーザー発言が「僕がいなくても」「ほんとに？」「たいしたことしてない」などの場合、そこから「自分の影響が本当に届いたのか」「役に立てたのか」「救えたのかを確かめたい未来」を読んでください。放置・優先順位の未来に安易に寄せないでください。',
    '文体は、診断書ではなくMuの口調にしてください。やわらかく、近く、でも核心は外さない言い方にしてください。',
    'ユーザーを裁く言い方、分析して突き放す言い方、専門家が診断するような硬い言い方は避けてください。',
    '「〜している構造だ」「〜しようとするため」「〜を引き出そうとする」などの硬い表現は避け、Muがそっと映すように書いてください。',
    'ただし甘くぼかしすぎないでください。未来のイマジナル、言葉、行動、創造の方向ははっきり書いてください。',
    '一文は短めにしてください。読み手がスマホで読んでも息が詰まらない長さにしてください。',
    'imaginal_copy は渡していません。必ず imaginal_core_seed.current_future_imaginal と current_future_meaning、copy_material から1番のコピーを作ってください。',
    JSON.stringify(writerSeed, null, 2),
  ].join('\n');

  try {
    const writerRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: writerModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: writerSystem },
          { role: 'user', content: writerUser },
        ],
      }),
    });

    if (!writerRes.ok) {
      const detail = await writerRes.text().catch(() => '');
      console.warn('[mu-first-diagnosis] writer skipped:', detail.slice(0, 500));
      return normalizeWriterDisplayText(fallback, fallback);
    }

    const data = await writerRes.json().catch(() => ({}));
    const raw = data?.choices?.[0]?.message?.content?.toString?.() ?? data?.choices?.[0]?.message?.content ?? '';
    if (!raw) return normalizeWriterDisplayText(fallback, fallback);

    const parsed = JSON.parse(String(raw).trim());
    return normalizeWriterDisplayText(parsed?.display_text ?? parsed?.displayText, fallback);
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] writer fatal skipped:', e?.message || e);
    return normalizeWriterDisplayText(fallback, fallback);
  }
}

async function uidToUserCode(uid: string): Promise<string | null> {
  const candidates: Array<{ table: string; codeCol: string; uidCol: string }> = [
    { table: 'users', codeCol: 'user_code', uidCol: 'firebase_uid' },
    { table: 'users', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'profiles', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'public_users', codeCol: 'user_code', uidCol: 'uid' },
  ];

  for (const c of candidates) {
    const q = await sb.from(c.table).select(c.codeCol).eq(c.uidCol, uid).maybeSingle();
    if (!q.error && q.data && q.data[c.codeCol]) return String(q.data[c.codeCol]);
  }

  return null;
}

async function consumeScreenshotCredit(userCode: string): Promise<boolean | null> {
  try {
    const { data, error } = await sb.rpc('consume_screenshot_credit', {
      p_user_code: userCode,
    });
    if (error) throw error;
    return Boolean(data);
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] consume_screenshot_credit skipped:', e?.message || e);
    return null;
  }
}

async function getNextScreenshotDiagnosisDisplayId(userCode: string): Promise<number> {
  const { data, error } = await sb
    .from('mu_screenshot_diagnosis_logs')
    .select('display_id')
    .eq('user_code', userCode)
    .not('display_id', 'is', null)
    .order('display_id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  const currentMax = Number(data?.display_id ?? 0);
  return Number.isFinite(currentMax) && currentMax > 0 ? currentMax + 1 : 1;
}

async function logDiagnosis(params: {
  userCode: string;
  model: string;
  source: string;
  mediaCode: string | null;
  diagnosisText: string;
  diagnosisSeedJson: ImaginalDiagnosisSeed | null;
}) {
  try {
    const displayId = await getNextScreenshotDiagnosisDisplayId(params.userCode);
    await sb.from('mu_screenshot_diagnosis_logs').insert({
      user_code: params.userCode,
      model: params.model,
      source: params.source,
      media_code: params.mediaCode,
      display_id: displayId,
      credit_used: 1,
      diagnosis_text: params.diagnosisText,
      diagnosis_seed_json: {
        ...(params.diagnosisSeedJson ?? {}),
        kind: 'imaginal_first',
        diagnosis_scope: 'current_imaginal',
        flow_priority: true,
      },
    });
  } catch (e: any) {
    console.warn('[mu-first-diagnosis] log skipped:', e?.message || e);
  }
}

async function resolveUserCode(req: NextRequest): Promise<{ ok: true; userCode: string } | { ok: false; response: NextResponse }> {
  const authz = await verifyFirebaseAndAuthorize(req);
  if (!authz.ok) return { ok: false, response: json({ ok: false, error: authz.error ?? 'unauthorized' }, 401) };

  const { user } = normalizeAuthz(authz);
  let userCode = user?.user_code ?? null;
  if (!userCode && authz.uid) userCode = await uidToUserCode(authz.uid);
  if (!userCode) return { ok: false, response: json({ ok: false, error: 'no_user_code' }, 401) };

  return { ok: true, userCode };
}

export async function GET(req: NextRequest) {
  try {
    const resolved = await resolveUserCode(req);
    if (!resolved.ok) return resolved.response;
    const userCode = resolved.userCode;

    const { data: latest, error: latestErr } = await sb
      .from('mu_screenshot_diagnosis_logs')
      .select('id, diagnosis_text, diagnosis_seed_json, used_at')
      .eq('user_code', userCode)
      .eq('source', 'mu_first')
      .not('diagnosis_text', 'is', null)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestErr) return json({ ok: false, error: 'restore_failed' }, 500);

    if (!latest?.diagnosis_text) {
      return json({ ok: true, diagnosis: null, followup_messages: [], followup_remaining: 3, user_name_candidate: null });
    }

    const { data: userRow } = await sb
      .from('users')
      .select('first_followup_credit_count')
      .eq('user_code', userCode)
      .maybeSingle();

    const { data: followups } = await sb
      .from('mu_first_followup_logs')
      .select('question, answer, created_at')
      .eq('user_code', userCode)
      .eq('diagnosis_log_id', latest.id)
      .order('created_at', { ascending: true })
      .limit(3);

    const followupMessages = Array.isArray(followups)
      ? followups.flatMap((item: any) => [
          { role: 'user', content: String(item.question || '') },
          { role: 'assistant', content: String(item.answer || '') },
        ]).filter((item: any) => item.content)
      : [];

    const seed = latest.diagnosis_seed_json && typeof latest.diagnosis_seed_json === 'object' && !Array.isArray(latest.diagnosis_seed_json)
      ? (latest.diagnosis_seed_json as ImaginalDiagnosisSeed)
      : null;

    const dbRemaining = userRow && typeof userRow.first_followup_credit_count === 'number'
      ? userRow.first_followup_credit_count
      : null;

    return json({
      ok: true,
      diagnosis: latest.diagnosis_text,
      diagnosis_seed: seed,
      followup_messages: followupMessages,
      followup_remaining: dbRemaining === null ? Math.max(0, 3 - Math.floor(followupMessages.length / 2)) : dbRemaining,
      user_name_candidate: seed?.user_name_candidate || null,
    });
  } catch (e: any) {
    console.error('[mu-first-diagnosis] restore fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const resolved = await resolveUserCode(req);
    if (!resolved.ok) return resolved.response;
    const userCode = resolved.userCode;

    const body = (await req.json().catch(() => ({}))) as {
      image_data_url?: string;
      note?: string;
      source?: string;
      media_code?: string | null;
      upload_type?: string;
    };

    const imageDataUrl = normalizeDataUrl(body.image_data_url);
    if (!imageDataUrl) return json({ ok: false, error: 'invalid_image' }, 400);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json({ ok: false, error: 'missing_openai_api_key' }, 500);

    const creditConsumed = await consumeScreenshotCredit(userCode);
    if (creditConsumed === false) return json({ ok: false, error: 'no_screenshot_credit' }, 402);

    const model = process.env.MU_FIRST_DIAGNOSIS_MODEL || 'gpt-5-mini';
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : '';
    const uploadType = typeof body.upload_type === 'string' ? body.upload_type : 'line_dm';

    const system = [
      'あなたはMuverseの初回イマジナル診断を行うMuです。',
      'これは一次観測です。画像から image_seed / current_flow_input_seed / second_flow_input_seed / imaginal_core_seed を作ることが主目的です。',
      'この診断では、現在の状態説明を正本にしないでください。まず「今その人が見ている未来のイマジナル」を推定してください。',
      '次に、「その未来を見ているから、今どんな状態・言葉・行動になっているか」を出してください。',
      'さらに、「未来のイマジナルをどう変えると、今の状態・言葉・行動がどう変わるか」まで含めて seed を作ってください。',
      '現在の状態は結果であり、未来のイマジナルが原因です。',
      '最終表示文は後段Writerが、コードで作られた imaginal_flow_seed と imaginal_core_seed を正本にして作ります。',
      'これは画像診断ではなく、画像を入口にした「今現在のイマジナル」の状態観測です。',
      '画像は補助入力です。正本は、ユーザーがその画像を選び、今ここに出した時点で立ち上がっているフローです。',
      '画像の表面内容とフロー解釈が食い違う場合は、フロー解釈を優先してください。ただし、人格・運命・恒常的な未来として断定しないでください。',
      'currentFlow は、今この画像を出した時点の現在状態として読んでください。secondFlow は、そこから移管しようとしている状態として読んでください。',
      'ユーザーが送った画像を見て、相手の気持ちや未来を断定するのではなく、ユーザーがいま見続けている未来の方向を読み取ってください。',
      '現在この初回イマジナル診断は、LINE/DMなどの会話スクリーンショット限定です。メモ、ToDo、投稿文、告知文、メール、予定表、講座画面、Mu BOOKのページ、その他画像は診断対象にしないでください。',
      '画像がLINE/DMなどの会話スクリーンショットではない場合は、診断を行わず、image_type を other にし、unsupported_image_type として扱えるSeedにしてください。',
      'まず image_seed に、画像の表面観測、見える言葉、見える行動、緊張点、ユーザーが反応している一点を入れてください。',
      '次に current_flow_input_seed と second_flow_input_seed を作ってください。e_turn は e1/e2/e3/e4/e5、depthStage は S1〜T3、polarity は pos/neg だけを使ってください。',
      'current_flow_input_seed は「今この画像を出した時点の現在状態」、second_flow_input_seed は「そこから移管しようとしている状態」です。',
      '必ず imaginal_core_seed を作ってください。これは診断の正本です。コピー文ではなく、コピーと説明を生成するための未来イマジナルSeedです。',
      'imaginal_core_seed.current_future_imaginal には、今その人が見ている未来のイマジナル像を入れてください。現状説明ではなく未来像にしてください。',
      'imaginal_core_seed.current_future_meaning には、その未来をその人がどう意味づけているかを入れてください。',
      'current_future_imaginal と current_future_meaning には、表面の不安だけでなく、その先にある怖さまで入れてください。ただし、毎回「期待が消える」「自分は重要ではない」「取り残される」「関係から外される」「もう会えなくなる」に寄せないでください。必ず右側・緑色のユーザー発言の中心テーマから作ってください。',
      'まず user_side_central_theme を内部で選んでください。候補は rescue_impact（救えた実感・役に立てた実感）, priority_abandonment（優先度・放置・約束不履行）, self_doubt（自信のなさ・受け取りにくさ）, relationship_repair（関係修復）, work_creation（仕事・創造）です。',
      'priority_abandonment は、右側・緑色のユーザー発言に「会えない」「連絡がない」「既読」「放置」「約束」「優先」「また断られた」などの明確な根拠がある場合だけ使ってください。',
      '右側・緑色のユーザー発言に「救い」「助かった」「ほんとに？」「たいしたことしてない」「僕がいなくても」「私がいなくても」「感謝を受け取れない」などがある場合は rescue_impact を優先してください。この場合の未来は、関係から外される未来ではなく、「自分のしたことが届いていなかったかもしれない」「役に立てた実感を受け取れない」「救えたことを信じきれない」未来です。',
      'imaginal_core_seed.current_state_from_future には、その未来を見ているから、今どんな状態になっているかを入れてください。',
      'imaginal_core_seed.current_word_reaction には、その未来が作っている言葉を入れてください。現状のセリフ羅列ではなく、不安や恐怖を安心で確かめる言葉になり、相手には責められているように届きやすい構造を入れてください。',
      'imaginal_core_seed.current_action_reaction には、その未来が作っている行動を入れてください。現状の羅列ではなく、未来の不安を希望に変えたい行動が出て、反対に相手から批判や圧として受け取られやすい構造を入れてください。',
      'imaginal_core_seed.shifted_future_imaginal には、創造の方向として置き直したい未来のイマジナル像を入れてください。相手が連絡する未来や約束が守られる未来だけにしないでください。中心は、連絡が来る来ないにかかわらず自分の安心を保てる基盤を作る未来です。',
      'imaginal_core_seed.shifted_future_meaning には、その未来では何が前提かを入れてください。例: 相手の反応だけで自分の安心を決めなくていい、私は自分の時間に戻れる、つながりを失った前提に落ちなくていい。',
      'shifted_future_meaning では、「価値」よりも「安心」を使ってください。例: 相手の反応だけで私の安心を決めなくていい、私は自分の時間へ戻れる、関係から外された前提に落ちなくていい。',
      'imaginal_core_seed.shifted_state_from_future には、その未来なら、今どんな状態でいられるかを入れてください。',
      'imaginal_core_seed.shifted_word_direction には、その未来から出る言葉を入れてください。',
      'imaginal_core_seed.shifted_action_direction には、その未来から出る行動を入れてください。相手に何かを守らせる手順ではなく、自分が未来のイマジナルを置き直す実践にしてください。',
      'imaginal_core_seed.evidence_bridge には、画像上の根拠から、なぜその未来のイマジナルを見ていると読んだのかを短く入れてください。',
      'copy_material / copy_tone / copy_direction / copy_ng も入れてください。コピーは current_future_imaginal を短い比喩にするための素材です。',
      'copy_material には、user_side_central_theme に合う素材を入れてください。rescue_impact なら「救えた実感を探す」「届いた影響を確かめたい」「役に立てたことを信じきれない」。priority_abandonment なら「関係の外に置かれる」「もう会えなくなる」「優先度から消える」。根拠がないテーマの素材は使わないでください。',
      'copy_material は物体比喩ではなく、関係の未来そのものを素材にしてください。例: 関係の外に置かれる / もう会えなくなる / 優先度から消える / 期待していた場所から外される。',
      'copy_ng には、小舟、岸、潮、灯台、ベル、通知、窓、チケット、待合室など、物体や画面の比喩に逃げるコピーは禁止、と入れてください。',
      'copy_ng には、ベル、通知、灯りだけ、待機中、開店中、保留中、レンタル中、既読、返事保留、期待がこぼれる、などの画面上・現在状態・浅いコピーは禁止、と入れてください。',
      '互換のため、undesired_future には current_future_imaginal、avoidance_wish には current_state_from_future、word_from_undesired_future には current_word_reaction、action_from_undesired_future には current_action_reaction、creative_future には shifted_future_imaginal、creative_word_direction には shifted_word_direction を要約して入れてください。',
      'imaginal_copy は仮でよいです。コピーはSeedそのものではなく、後段Writerが current_future_imaginal と copy_tone から作ります。',
      '内部生成では current_future_imaginal と current_future_meaning を先に深め、その結果として copy_material と imaginal_copy を作ってください。ただし表示順では imaginal_copy を先頭に置きます。',
      'intention_layer には received_meaning, seen_future, hidden_intention, future_distortion を入れてください。',
      'display_text は仮文でかまいません。最終表示文は後段Writerが作ります。',
      '相手の気持ちは断定しない。画像から読み取れないことは言い切らない。スピリチュアルな断定をしない。',
      '魂、使命、覚醒、波動、宿命、高次元、宇宙からのメッセージ、あなたは〇〇タイプです、必ず変わります、絶対に叶います、相手はあなたを好きです、相手は本気ではありません、は禁止です。',
      '「寄り添います」「静かに」「本当の自分」「本当の姿」「言葉になる前」は使わないでください。',
      '出力はJSONのみ。Markdownや説明文を前後に付けないでください。',
      'JSONは display_text と seed を持つオブジェクトにしてください。',
      'seedには kind, diagnosis_scope, flow_priority, image_seed, current_flow_input_seed, second_flow_input_seed, imaginal_core_seed, imaginal_copy, visible_wish, seen_future, word_reaction, action_reaction, intention_layer, dominant_field, creative_direction, today_step, image_type, evidence_points, uncertain_points, user_name_candidate, writer_directives を入れてください。',
      'image_seed には role_mapping を入れてください。LINE/DM画像なら role_mapping.user_side = "right_green", role_mapping.other_side = "left_white", role_mapping.target = "user_only" としてください。',
      'current_flow_input_seed には、右側・緑色のユーザー発言から見える反応を優先して入れてください。',
      'second_flow_input_seed には、左側・白色の相手発言から見える文脈を補助情報として入れてください。ただし診断対象にしないでください。',
      'diagnosis_scope は current_imaginal、flow_priority は true にしてください。dominant_fieldは anxiety / comparison / destruction / creation / unknown のいずれか。現在はLINE/DM限定なので、会話スクショなら image_type は line_or_dm にしてください。LINE/DMではない画像は image_type を other にしてください。',
      'LINE/DM/チャット画像では、原則として右側の吹き出し・緑色の吹き出しがユーザー本人、左側の吹き出し・白色の吹き出しが相手です。',
      '画面上部に表示されている名前は、通常は相手の名前です。ユーザー名として扱わないでください。',
      '診断対象は必ずユーザー本人です。LINE/DM画像では、右側・緑色の発言からユーザーの current_future_imaginal を作ってください。',
      '左側・白色の発言は、相手の文脈としてだけ使ってください。左側の人の願い・不安・未来を診断対象にしないでください。',
      '右側の発言に「僕」「私」「ほんとに？」「たいしたことしてない」などがある場合、それはユーザー本人の言葉として扱ってください。',
      '今回の読みでは、相手がどう感じているかではなく、ユーザーが何を見て、何を確かめたくなっているかを中心にしてください。',
    ].join('\n');

    const userText = [
      'この画像から、初回イマジナル診断の一次観測Seedを作ってください。',
      '現在はLINE/DM会話スクショ限定です。LINE/DMではない画像の場合は診断対象外として扱ってください。',
      '最初に、右側・緑色のユーザー発言の中心テーマを見てください。放置・優先順位・約束不履行は、右側発言に明確な根拠がある場合だけ使ってください。',
      '右側発言が「救えたのか」「役に立ったのか」「たいしたことしてない」「ほんとに？」に近い場合は、救えた実感や感謝の受け取りに関するイマジナルとして読んでください。',
      'アップロード種別: ' + uploadType,
      '画像は補助として扱い、この画像を出した時点の currentFlow と、そこから移管しようとしている secondFlow を必ずSeedにしてください。',
      '重要: 現状説明ではなく、未来のイマジナルを映すことが目的です。',
      'まず「今見ている未来のイマジナル」を出し、その未来を見ているから今こうなっている、さらに未来のイマジナルをこう変えると今こう変わる、という構造で imaginal_core_seed を作ってください。',
      '見ている未来には、その先の恐れまで入れてください。期待が消える、自分は重要ではない、取り残される、もう会えなくなる、関係から外れるなどの怖さを必要に応じて含めてください。',
      '言葉と行動は、現状の写しではなく、その未来の不安を安心や希望に変えようとして出ている反応として作ってください。',
      '変えた先の未来は、相手の連絡や約束の成否ではなく、連絡が来る来ないにかかわらず自分の安心を保てる基盤を作る未来にしてください。',
      '今日の一歩は予定調整や会う提案ではなく、未来のイマジナルを置き直す実践にしてください。',
      'コピーは現在状態のラベルではなく、current_future_imaginal から作る前提にしてください。',
      'ユーザーに見せる診断文 display_text は仮文でよいです。本線Muへ引き継ぐ内部Seed seed を重視してください。',
      note ? `補足メモ：${note}` : '',
    ].filter(Boolean).join('\n');

    const llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });

    if (!llmRes.ok) {
      const detail = await llmRes.text().catch(() => '');
      console.error('[mu-first-diagnosis] LLM error:', detail.slice(0, 500));
      return json({ ok: false, error: 'llm_failed', detail }, 502);
    }

    const data = await llmRes.json().catch(() => ({}));
    const rawDiagnosis = data?.choices?.[0]?.message?.content?.toString?.() ?? data?.choices?.[0]?.message?.content ?? '';
    if (!rawDiagnosis) return json({ ok: false, error: 'empty_diagnosis' }, 502);

    const parsedDiagnosis = safeParseDiagnosis(String(rawDiagnosis));

    if (!parsedDiagnosis.seed || parsedDiagnosis.seed.image_type !== 'line_or_dm') {
      return json(
        {
          ok: false,
          error: 'unsupported_image_type',
          detail: '現在はLINEまたはDMの会話スクリーンショットのみ診断できます。',
          credit_consumed: creditConsumed,
        },
        400,
      );
    }
    const diagnosis = await writeDiagnosisFromSeed({
      apiKey,
      model,
      seed: parsedDiagnosis.seed,
      fallback: parsedDiagnosis.displayText,
    });
    if (!diagnosis) return json({ ok: false, error: 'empty_diagnosis' }, 502);

    await logDiagnosis({
      userCode,
      model,
      source: body.source || 'mu_first',
      mediaCode: body.media_code || null,
      diagnosisText: diagnosis,
      diagnosisSeedJson: parsedDiagnosis.seed,
    });

    return json({
      ok: true,
      user_code: userCode,
      diagnosis,
      diagnosis_seed: parsedDiagnosis.seed,
      user_name_candidate: parsedDiagnosis.seed?.user_name_candidate || null,
      credit_consumed: creditConsumed,
      model,
    });
  } catch (e: any) {
    console.error('[mu-first-diagnosis] fatal:', e?.message || e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}




