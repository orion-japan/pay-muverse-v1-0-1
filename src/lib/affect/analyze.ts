import { inferQCode } from './qcode';
import { inferIntent } from './intent';
import { AffectAnalysis, Phase, SelfAcceptance, Relation } from './types';

function inferPhase(text: string): Phase {
  const t = (text || '').toLowerCase();
  const innerK = ['気持ち','感情','不安','イライラ','怖','心','胸','わたし','私'];
  const outerK = ['上司','相手','会議','職場','メール','チーム','外部','環境'];
  const inner = innerK.some(k => t.includes(k.toLowerCase()));
  const outer = outerK.some(k => t.includes(k.toLowerCase()));
  if (inner && !outer) return 'Inner';
  if (outer && !inner) return 'Outer';
  return 'Inner';
}
function inferSelfAcceptance(text: string): SelfAcceptance {
  const t = (text || '').toLowerCase();
  let score = 50;
  if (/(できない|無理|最悪|ダメ|嫌い|消えたい)/.test(t)) score -= 10;
  if (/(大丈夫|できた|よかった|助かった|嬉しい|安心)/.test(t)) score += 10;
  score = Math.max(0, Math.min(100, score));
  const band: SelfAcceptance['band'] = score < 40 ? '0_40' : score <= 70 ? '40_70' : '70_100';
  return { score, band };
}
function inferRelation(text: string): Relation {
  const t = (text || '').toLowerCase();
  if (/(上司|相手|部下|顧客|家族|友人)/.test(t)) {
    if (/(対立|怒|苛立|もめ|争)/.test(t)) return { label: 'tension', confidence: 0.7 };
    return { label: 'harmony', confidence: 0.6 };
  }
  return { label: 'neutral', confidence: 0.5 };
}

/** 全エージェント共通：Qコード＋意図＋補助メタ */
export async function analyzeAffect(userText: string) {
  const [q, intent] = await Promise.all([
    inferQCode(userText),
    Promise.resolve(inferIntent(userText)),
  ]);
  const phase = inferPhase(userText);
  const selfAcceptance = inferSelfAcceptance(userText);
  const relation = inferRelation(userText);
  return { q, intent, phase, selfAcceptance, relation };
}
