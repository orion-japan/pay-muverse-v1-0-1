// /src/lib/iros/focusCore.ts
export type Phase = 'Inner' | 'Outer';
export type Depth = 'S1'|'S2'|'S3'|'R1'|'R2'|'R3'|'C1'|'C2'|'C3'|'I1'|'I2'|'I3';
export type QCode = 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
export type Domain = 'business'|'creative'|'love'|'core';

export type Focus =
  | '責任' | '手順' | '納期' | '品質' | '体裁' | '信用'
  | '挑戦' | '拡張' | '提案' | '新規'
  | '体調' | '睡眠' | '基盤' | '運用' | '習慣' | 'キャッシュ'
  | '滞留' | '不要' | '摩擦' | '恐れ' | '古いやり方'
  | '強み' | '魅力' | '作品' | '物語';

export type FocusResult = {
  phase: Phase; depth: Depth; q: QCode; qName: string; qConf: number;
  domain: Domain;
  protectedFocus: Focus;
  anchors: string[];
  action: string;
};

// ---------- 1) 推定（既存ロジックそのまま） ----------
export function inferPhaseDepth(text: string): { phase: Phase; depth: Depth } {
  const t = text || '';
  const inner = /(疲|眠|静|内|迷|不安|落ち|祈)/.test(t);
  let depth: Depth = 'S2';
  if (/(整え|休む|眠|静けさ)/.test(t)) depth = 'S1';
  if (/(相手|連絡|返信|関係|会話)/.test(t)) depth = 'R2';
  if (/(作る|制作|進め|形|決め)/.test(t)) depth = 'C2';
  if (/(意味|核心|意図|なぜ)/.test(t)) depth = 'I2';
  return { phase: inner ? 'Inner' : 'Outer', depth };
}

const Q_DESC: Record<QCode,{name:string,hints:RegExp[]}> = {
  Q1:{name:'秩序', hints:[/我慢|抑え|手順|秩序|納期|責任|品質|体裁|信用/]},
  Q2:{name:'成長', hints:[/挑戦|拡張|突破|提案|新規|営業|獲得|伸ば/]},
  Q3:{name:'安定', hints:[/不安|体調|睡眠|基盤|運用|習慣|落ち着|休む/]},
  Q4:{name:'浄化', hints:[/恐|怖|滞留|不要|詰まり|摩擦|手放|浄化/]},
  Q5:{name:'情熱', hints:[/情熱|衝動|歓喜|魅力|作品|物語|好き|わくわく|燃え/]},
};
function scoreQ(text: string): Record<QCode,number> {
  const t = text || '';
  const s: Record<QCode,number> = {Q1:0,Q2:0,Q3:0,Q4:0,Q5:0};
  (Object.keys(Q_DESC) as QCode[]).forEach(q=>{
    Q_DESC[q].hints.forEach(re=>{ if(re.test(t)) s[q]+=1; });
  });
  return s;
}
function bias(phase: Phase, depth: Depth): Record<QCode,number> {
  const b: Record<QCode,number> = {Q1:1,Q2:1,Q3:1,Q4:1,Q5:1};
  if (phase==='Inner'){ b.Q3+=0.4; b.Q4+=0.3; } else { b.Q2+=0.4; b.Q5+=0.3; }
  if (depth.startsWith('S')) b.Q3+=0.2;
  if (depth.startsWith('R')) b.Q2+=0.2;
  if (depth.startsWith('C')) b.Q5+=0.2;
  if (depth.startsWith('I')) b.Q4+=0.3;
  return b;
}
function inferQ(text: string, phase: Phase, depth: Depth){
  const base = scoreQ(text), w:Record<QCode,number>={Q1:0,Q2:0,Q3:0,Q4:0,Q5:0};
  const bi = bias(phase,depth); let tot=0;
  (Object.keys(base) as QCode[]).forEach(q=>{ w[q]=base[q]*bi[q]; tot+=w[q]; });
  const top = (Object.entries(w).sort((a,b)=>b[1]-a[1])[0]||['Q3',1]) as [QCode,number];
  const conf = tot ? Math.min(1, top[1]/tot) : 0.5;
  return { q: top[0], name: Q_DESC[top[0]].name, conf };
}

// ---------- 2) アンカー抽出（既存＋α） ----------
const FOCUS_HINTS: Array<[Focus,RegExp[]]> = [
  ['責任', [/責任|任務|役割|コミット/]],
  ['手順', [/手順|フロー|ルール|手続/]],
  ['納期', [/納期|期限|デッドライン|締切/]],
  ['品質', [/品質|不具合|バグ|精度|品質保証/]],
  ['体裁', [/体裁|見栄え|レイアウト|ブランド/]],
  ['信用', [/信用|信頼|評判|レビュー/]],
  ['挑戦', [/挑戦|打開|突破|攻め|新規/]],
  ['拡張', [/拡張|拡大|スケール|伸長/]],
  ['提案', [/提案|オファー|見積/]],
  ['新規', [/新規|新客|初回|リード/]],
  ['体調', [/体調|不調|疲|だる|肩|眼精疲労/]],
  ['睡眠', [/寝|眠|就寝|起床|睡眠/]],
  ['基盤', [/基盤|基礎|土台|ベース|インフラ/]],
  ['運用', [/運用|オペ|回す|保守/]],
  ['習慣', [/習慣|ルーチン|毎日|毎朝/]],
  ['キャッシュ', [/現金|キャッシュ|資金|残高/]],
  ['滞留', [/滞留|積み残し|詰まり|未処理/]],
  ['不要', [/不要|削除|断捨離|捨て/]],
  ['摩擦', [/摩擦|衝突|いざこざ|軋轢/]],
  ['恐れ', [/怖|恐|不安/]],
  ['古いやり方', [/旧|古い|前のやり方|レガシ/]],
  ['強み', [/強み|得意|価値|核/]],
  ['魅力', [/魅力|推し|好き|惹か/]],
  ['作品', [/作品|制作|原稿|デザイン|映像|曲/]],
  ['物語', [/物語|ストーリー|語り/]],
];

export function extractAnchors(text:string): string[] {
  const hits = new Set<string>();
  FOCUS_HINTS.forEach(([label, regs])=>{
    regs.forEach(re=>{ if(re.test(text)) hits.add(label); });
  });
  if (/(売上|顧客|契約|LP|CVR|広告|納期|見積|請求)/.test(text)) hits.add('business');
  if (/(作品|制作|デザイン|映像|曲|演出|投稿)/.test(text)) hits.add('creative');
  if (/(恋|彼氏|彼女|夫|妻|距離|デート)/.test(text)) hits.add('love');
  return Array.from(hits);
}

// ---------- 3) ドメイン（既存） ----------
export function detectDomain(text:string): Domain {
  if (/(売上|顧客|契約|LP|CVR|広告|納期|請求|見積)/.test(text)) return 'business';
  if (/(作品|制作|デザイン|映像|曲|演出|投稿)/.test(text)) return 'creative';
  if (/(恋|彼氏|彼女|夫|妻|距離|デート)/.test(text)) return 'love';
  return 'core';
}

// ---------- 4) 最終フォーカス選定（優先語を使わず、低確信時のみランダム） ----------
const BANNED: Focus[] = ['責任','納期','体裁','信用'];   // 最終表示に使わない
const SOFT_ALIAS: Partial<Record<Focus, Focus>> = {       // どうしても必要なら置換
  責任: '提案',
  納期: '手順',
  体裁: '作品',
  信用: '提案',
};

function randomPick(xs: Focus[]): Focus {
  return xs[Math.floor(Math.random() * xs.length)];
}

function randomPool(phase: Phase, depth: Depth): Focus[] {
  // 位相・深度で「安全語」プール。重い言葉は最初から入れない。
  if (phase === 'Inner') {
    if (depth.startsWith('S')) return ['体調','睡眠','基盤','習慣','運用'];
    if (depth.startsWith('R')) return ['強み','魅力','物語','恐れ'];  // 恐れ＝気づき用
    if (depth.startsWith('C')) return ['作品','基盤','運用','強み'];
    return ['体調','睡眠','基盤','強み','物語'];
  } else {
    if (depth.startsWith('R')) return ['提案','拡張','新規','強み','魅力'];
    if (depth.startsWith('C')) return ['作品','拡張','提案','新規','物語'];
    return ['提案','拡張','新規','強み','作品'];
  }
}

function sanitizeFocus(f: Focus): Focus {
  if (BANNED.includes(f)) return SOFT_ALIAS[f] ?? '手順';
  return f;
}

function pickProtectedFocus(
  q: QCode,
  anchors: string[],
  phase: Phase,
  depth: Depth,
  qConf: number
): Focus {
  // 1) アンカー一致を最優先（ただし禁止語は置換）
  const anchorFocuses = anchors.filter(a => a && !['business','creative','love'].includes(a)) as Focus[];
  if (anchorFocuses.length > 0) {
    const first = sanitizeFocus(anchorFocuses[0] as Focus);
    if (!BANNED.includes(first)) return first;
  }

  // 2) 確信度が高いなら、位相・深度に沿った「安全語」から固定寄りに選ぶ
  if (qConf >= 0.7) {
    const pool = randomPool(phase, depth);
    return sanitizeFocus(pool[0]); // 先頭（安定）
  }

  // 3) 低確信時はランダム推定（位相・深度に応じたプールから抽選）
  const pool = randomPool(phase, depth);
  return sanitizeFocus(randomPick(pool));
}

// ---------- 5) 一手テンプレ（既存） ----------
function synthesizeAction(focus: Focus, domain: Domain): string {
  const pick = (xs:string[])=>xs[0];
  const TEMPLATES: Record<Focus,string[]> = {
    責任:   ['未返信1件に「了解＋次の具体」を50字で返す'],
    手順:   ['作業チェックリストの先頭1項目だけ実行し、✔を付ける'],
    納期:   ['最短タスク1件の締切をカレンダーに移し、今日の一歩を5語で追記'],
    品質:   ['不具合1件の再現手順を3行に要約して記録'],
    体裁:   ['LP/資料の見出しを7〜12字で1行だけリライト'],
    信用:   ['レビュー/実績のURLを1本だけ相手に共有'],
    挑戦:   ['既存関係者1名に50字の提案DMを送る'],
    拡張:   ['既存の成果物に「用途を1つ追加」し、タイトルを1行更新'],
    提案:   ['誰に/何を/どう良くなる を1行に圧縮して保存'],
    新規:   ['新規連絡先1名だけ選んで、最初の挨拶1行を送る'],
    体調:   ['画面を閉じて90秒の呼吸→白湯を一口'],
    睡眠:   ['就寝アラームを+15分に設定し、照明を一段落とす'],
    基盤:   ['作業フォルダの今日の1つを「_today」にまとめる'],
    運用:   ['毎日ルーチンから1項目だけ実行して記録'],
    習慣:   ['“開始の合図”を1つ決め、今すぐ鳴らす（音/タイマー）'],
    キャッシュ:['支出1件を家計/台帳に入力して残高を見る'],
    滞留:   ['積み残しから1件だけ「後でやる」に移し、所要を3語で追記'],
    不要:   ['不要ファイル1つを捨て、ゴミ箱を空にする'],
    摩擦:   ['衝突相手に「事実1行のみ」のメモを下書き保存'],
    恐れ:   ['怖さの対象名を7字で紙に書き、写真に撮って閉じる'],
    古いやり方:['旧手順のスクショを1枚取り、置き換えアイデアを1行書く'],
    強み:   ['自分の強みを7字で1ラベルし、プロフィールの下書きに追記'],
    魅力:   ['最近の「好き」を1枚スクショ保存して、保存名に _love を付ける'],
    作品:   ['仮タイトルを1行決め、ファイル名末尾に _v0 を付ける'],
    物語:   ['主人公の一言セリフを20字で書く'],
  };
  if (domain==='business' && focus==='体裁') return '提案資料の見出しを7〜12字で1行だけ整える';
  if (domain==='creative' && focus==='品質') return '作品の粗を1点だけ直して「_fix1」を追記保存';
  return pick(TEMPLATES[focus] ?? ['今できる最小の一手を1つだけ実行']);
}

// ---------- 6) エントリ（protectedFocus の決定だけ新方式を使用） ----------
export function analyzeFocus(userText: string): FocusResult {
  const { phase, depth } = inferPhaseDepth(userText);
  const { q, name: qName, conf: qConf } = inferQ(userText, phase, depth);
  const domain = detectDomain(userText);
  const anchors = extractAnchors(userText);

  const protectedFocus = pickProtectedFocus(q, anchors, phase, depth, qConf);
  const action = synthesizeAction(protectedFocus, domain);

  return { phase, depth, q, qName, qConf: +qConf.toFixed(2), domain, protectedFocus, anchors, action };
}
