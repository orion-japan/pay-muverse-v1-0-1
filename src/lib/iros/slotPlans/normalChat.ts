// src/lib/iros/slotPlans/normalChat.ts
// iros — normal chat slot plan (FINAL-only, flow-first, sofia-aligned)
//
// ✅ 目的（今回の修正）
// - 「意味に合った返答」は LLM に任せる（会話として噛み合わせる）
// - slotPlan は “口を塞ぐ禁止” を減らし、LLMが自然に答えられる余白を作る
// - ただし「判断/結論/誘導」は任せない（旗印は最低限だけ守る）
//
// 設計原則（normalChat）
// - 意味を決めない / 問題を特定しない / 正解を出さない（ただし “質問への返答” はする）
// - 会話の噛み合わせを最優先（聞かれたことに答える）
// - slotPlan は文章を書かない（ただし LLM 失敗時に UI が死なない seed は置く）
//
// ここは「浅くていい」担当：
// - 確証がないうちは GPT っぽい軽さでOK
// - 旗印は “強くやらない”。説教/誘導/断定/診断を避けるだけ守る


import type { SlotPlanPolicy } from '../server/llmGate';
import { observeFlow } from '../input/flowObserver';


// ✅ 追加：HowTo/方法質問を「立ち位置」へ変換する slots
import { shouldUseQuestionSlots, buildQuestionSlots } from './QuestionSlots';


// --------------------------------------------------
// types
// --------------------------------------------------


export type NormalChatSlot = {
 key: string;
 slotId?: string;
 role: 'assistant';
 style: 'neutral' | 'soft' | 'friendly';
 content: string; // writer 向けメタ（or seed text）
};


export type NormalChatSlotPlan = {
 kind: 'normal-chat';
 stamp: string;
 reason: string;
 slotPlanPolicy: SlotPlanPolicy;
 slots: NormalChatSlot[];
};


// --------------------------------------------------
// helpers
// --------------------------------------------------


function norm(s: unknown) {
 return String(s ?? '').replace(/\s+/g, ' ').trim();
}


function clamp(s: string, n: number) {
 if (s.length <= n) return s;
 return s.slice(0, Math.max(0, n - 1)) + '…';
}


function m(tag: string, payload?: Record<string, unknown>) {
 if (!payload || Object.keys(payload).length === 0) return `@${tag}`;
 try {
   return `@${tag} ${JSON.stringify(payload)}`;
 } catch {
   return `@${tag}`;
 }
}


function normalizeSlots(slots: NormalChatSlot[]): NormalChatSlot[] {
 let i = 0;
 return (Array.isArray(slots) ? slots : []).map((s) => ({
   ...s,
   slotId: s.slotId ?? `N${++i}`,
 }));
}


// deterministic tiny hash（ランダム禁止の代わり）
function hash32(s: string): number {
 let h = 2166136261;
 for (let i = 0; i < s.length; i++) {
   h ^= s.charCodeAt(i);
   h = Math.imul(h, 16777619);
 }
 return h >>> 0;
}


function pick<T>(arr: T[], seed: string): T {
 if (!arr.length) throw new Error('pick: empty');
 const idx = hash32(seed) % arr.length;
 return arr[idx]!;
}


// --------------------------------------------------
// minimal detectors（意味判定はしない）
// --------------------------------------------------


function isEnd(text: string) {
 const t = norm(text);
 return t === 'ここまで' || t === '以上' || t.includes('今日はここまで');
}


function isCompose(text: string) {
 const t = norm(text);
 return /(文章|文面|例文|文を作って|書いて|まとめて)/.test(t);
}


// ✅ 確認・ツッコミ・意味質問（会話の噛み合わせ優先）
function isClarify(text: string) {
 const t = norm(text);
 if (!t) return false;


 // 例: 何が強いの / それってどういう意味 / 何を出すの / どこが / なんでそう言った
 if (
   /^(何が|なにが|どこが|どれが|それって|それは|どういう意味|つまり|具体的に|なぜ|なんで|何で)\b/.test(
     t,
   )
 ) {
   return true;
 }


 if (/(って何|とは|意味|何を出す|何を言えば|何のこと|強いの|でしょ|なの)/.test(t)) {
   return true;
 }


 // 記号疑問（？/?) も拾う（短文の噛み合わせに効く）
 if (/[?？]/.test(t) && t.length <= 40) return true;


 return false;
}


// --------------------------------------------------
// slot builders
// --------------------------------------------------


function buildEmpty(): NormalChatSlot[] {
 return [{ key: 'EMPTY', role: 'assistant', style: 'soft', content: m('EMPTY') }];
}


function buildEnd(): NormalChatSlot[] {
 return [
   { key: 'END', role: 'assistant', style: 'soft', content: m('END') },
   { key: 'NEXT', role: 'assistant', style: 'neutral', content: m('NEXT', { reopen: true }) },
 ];
}


function buildCompose(userText: string): NormalChatSlot[] {
 const t = norm(userText);
 return [
   {
     key: 'TASK',
     role: 'assistant',
     style: 'neutral',
     content: m('TASK', { kind: 'compose', user: clamp(t, 240) }),
   },
   {
     key: 'DRAFT',
     role: 'assistant',
     style: 'soft',
     content: m('DRAFT', {
       rules: {
         no_advice: true,
         no_summary: true,
         no_checklist: true,
         questions_max: 1,
       },
     }),
   },
 ];
}


// ✅ clarify 用：テンプレで答えない。LLMに “意味に答える許可” を出す。
function buildClarify(userText: string): NormalChatSlot[] {
 const t = norm(userText);


 const seedFallbacks = [
   `いま聞いてるのは、「さっきの言い方が何を指してたか」だよね。\nここで言った「正解」は、“正しい答えを決める”じゃなくて“結論を確定させる”って意味。\n今は結論を作る前に、ズレた点を残したほうが会話が噛むと思った。`,
   `「何を出すの？」は、「次に何を言えば会話になる？」って意味だよね。\nここで“出す”のは、結論じゃなくて「いまズレたと感じたポイント」そのもの。\nズレの中でも、いちばん嫌だった一言はどれ？`,
   `「どういう意味？」は、言葉の定義を聞いてるんだよね。\nこの文の「強い」は、良い/正しいじゃなくて“迷わずそのまま出た”って意味で言った。\nもし違うなら、どんな言葉なら近い？`,
   `いまは「何の根拠でそう言った？」って確認だよね。\n根拠は評価じゃなくて、さっきの流れだとその言い回しが“意図とズレてる”ように見えたから。\nズレてるのが言葉なのか、前提なのか、どっちに近い？`,
 ];


 const seedText = pick(seedFallbacks, t);


 return [
   { key: 'SEED_TEXT', role: 'assistant', style: 'soft', content: seedText },
   {
     key: 'OBS',
     role: 'assistant',
     style: 'soft',
     content: m('OBS', { user: clamp(t, 240), kind: 'clarify', intent: 'answer_the_question' }),
   },
   {
     key: 'SHIFT',
     role: 'assistant',
     style: 'neutral',
     content: m('SHIFT', {
       kind: 'semantic_answer',
       output_contract: [
         'first_line_must_answer_question_directly',
         'no_question_back_as_first_line',
         'no_flow_lecture',
         'plain_words',
       ],
       forbid: ['diagnosis', 'preach', 'hard_guidance', 'forced_task'],
       questions_max: 1,
     }),
   },
 ];
}


// LLMが落ちても UI に出せる “自然な seed” を作る（通常会話用）
function buildSeedText(args: {
 userText: string;
 flowDelta: string;
 lastUserText?: string | null;
}): string {
 const u = norm(args.userText);
 const u60 = clamp(u, 60);


 const pickV = <T,>(arr: T[], seed: string, salt: string) => pick(arr, `${seed}#${salt}`);
 const join3 = (a: string, b: string, c: string) => [a, b, c].filter(Boolean).join('\n');


 const openers = [
   `了解。いまの一言、ちゃんと入ってきた。`,
   `うん、いまは「${u60}」って感じなんだね。`,
   `「${u60}」って言い方、いまの温度が出てる。`,
   `その言い回し、無理がなくていい。`,
   `そのまま出てきた言葉だね。`,
   `受け取った。ここから詰めなくていい。`,
   `いまの言い方、ちょっと素が混ざってる。`,
   `なるほど。いまはその温度のままでいける。`,
   `OK。いまの話、ちゃんとつながってる。`,
 ];


 const middles_forward = [
   `いまは細かく整えなくていい。話が動いてる所だけ見失わなければ進む。`,
   `深掘りはあとでいい。いま出てる感触をそのまま持っていける。`,
   `いまは説明より、続きが出る形で置いておくのが合ってる。`,
   `まとまらなくていい。出た順でいけば自然に続く。`,
 ];


 const middles_back = [
   `戻る感じがあっても普通。大事なのは「どこに戻ったか」だけ残すこと。`,
   `いまは結論に寄せなくていい。引っかかった地点をそのまま置いておける。`,
   `一度戻って見えることもある。戻った場所が分かれば次が決まる。`,
 ];


 const middles_stuck = [
   `詰まってるなら、原因探しは後でいい。まず「止まる場所」だけ見たい。`,
   `いま必要なのは勢いじゃなくて、次が出る置き方。`,
   `止まり気味でも大丈夫。止まった位置が分かれば会話は続く。`,
 ];


 const delta = String(args.flowDelta || 'FORWARD').toUpperCase();
 const middle =
   delta.includes('BACK') || delta.includes('RETURN')
     ? pickV(middles_back, u, delta)
     : delta.includes('STUCK') || delta.includes('STOP') || delta.includes('STALL')
       ? pickV(middles_stuck, u, delta)
       : pickV(middles_forward, u, delta);


 const exits = [
   `ここからは、前に動いた所を見てもいいし、止まった所を見てもいい。`,
   `次に触れるなら、いちばん言いやすい所からでいい。`,
   `この話、続きが出るなら「出来事の続き」か「自分の反応の続き」になりそう。`,
   `次は、いま頭に残ってる所に寄っていけば自然に続く。`,
 ];


 const opener = pickV(openers, u, String(args.lastUserText ?? ''));
 const exit = pickV(exits, u, delta);


 return join3(opener, middle, exit);
}


// ✅ HowTo/方法質問（QuestionSlots）を normalChat に合わせて正規化
function buildQuestion(userText: string, contextText?: string): NormalChatSlot[] {
  const slots = buildQuestionSlots({ userText, contextText });
  return slots.map((s) => ({
    key: s.key,
    role: 'assistant',
    style: (s.style ?? 'neutral') as any,
    content: s.content,
  }));
}

// ✅ normalChat の通常フロー：意味にあった返答を最優先で書かせる
function buildFlowReply(
 userText: string,
 flow: { delta: string; confidence?: number } | null,
 lastUserText?: string | null,
): NormalChatSlot[] {
 const t = norm(userText);
 const delta = flow?.delta ? String(flow.delta) : 'FORWARD';
 const conf = typeof flow?.confidence === 'number' ? flow!.confidence : undefined;


 // UIフォールバック（LLMが落ちたときだけ出る想定）
 const seedText = buildSeedText({
   userText: t,
   flowDelta: delta,
   lastUserText,
 });


 return [
  {
    key: 'OBS',
    role: 'assistant',
    style: 'soft',
    content: m('OBS', {
      user: clamp(t, 240),
    }),
  },
  {
    key: 'SHIFT',
    role: 'assistant',
    style: 'neutral',
    content: m('SHIFT', {
      kind: 'meaning_first',
      rules: {
        answer_user_meaning: true,
        avoid_template_praise: true,
        avoid_meta_flow_talk: true,
        avoid_generic_cheer: true,
        questions_max: 1,
      },
      allow: {
        concrete_reply: true,
        short_reply_ok: true,
      },
    }),
  },
];
}


// --------------------------------------------------
// main
// --------------------------------------------------


export function buildNormalChatSlotPlan(args: {
 userText: string;
 context?: {
   recentUserTexts?: string[];
   lastSummary?: string | null; // orchestrator互換（ここでは使わない）
 };
}): NormalChatSlotPlan {
 const stamp = 'normalChat@light-gptlike-v2+questionSlots';
 const userText = norm(args.userText);


 const recentRaw = Array.isArray(args.context?.recentUserTexts) ? args.context!.recentUserTexts! : [];
 const recent = recentRaw.map((x) => norm(x)).filter(Boolean);
 const lastUserText = recent.length > 0 ? recent[recent.length - 1] : null;


 let flow: { delta: string; confidence?: number } | null = null;
 try {
   flow = observeFlow({
     currentText: userText,
     lastUserText: lastUserText ?? undefined,
   }) as any;
 } catch {
   flow = { delta: 'FORWARD' };
 }


 let reason = 'flow';
 let slots: NormalChatSlot[] = [];


 if (!userText) {
  reason = 'empty';
  slots = buildEmpty();
} else if (isEnd(userText)) {
  reason = 'end';
  slots = buildEnd();
} else if (shouldUseQuestionSlots(userText)) {
  // ✅ HowTo/方法質問 → 立ち位置（QuestionSlots）を最優先（短縮要求に吸われない）
  reason = 'questionSlots';
  slots = buildQuestion(userText, lastUserText ?? undefined);
} else if (isClarify(userText)) {

  // ✅ まず噛ませる（意味に答える）
  reason = 'clarify';
  slots = buildClarify(userText);
} else if (isCompose(userText)) {
  reason = 'compose';
  slots = buildCompose(userText);
} else {
  const d = flow?.delta ? String(flow.delta) : 'FORWARD';
  reason = `flow:${d}`;
  slots = buildFlowReply(userText, flow, lastUserText);
}

 return {
   kind: 'normal-chat',
   stamp,
   reason,


   // ✅ normalChat は浅くていい：基本 UNKNOWN
   // - empty は UNKNOWN（何も返さない/出せないを許す）
   // - それ以外は FINAL（LLM通して噛ませる）
   slotPlanPolicy: reason === 'empty' ? 'UNKNOWN' : 'FINAL',


   slots: normalizeSlots(slots),
 };
}



