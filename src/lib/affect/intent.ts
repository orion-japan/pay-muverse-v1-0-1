import { Intent } from './types';

export function inferIntent(text: string): Intent {
  const t = (text || '').toLowerCase();

  const selfK = ['私','わたし','自分','気持ち','感情','不安','イライラ'];
  const otherK = ['上司','相手','あなた','彼','彼女','部下','顧客','家族','友人'];
  const taskK = ['締切','提出','会議','タスク','メール','資料','計画','準備'];

  const approachK = ['やってみたい','進めたい','挑戦','改善','話す','相談','整理'];
  const avoidK = ['避けたい','やめたい','怖い','萎縮','無理','不安','逃げたい'];

  const pastK = ['昨日','先日','過去','昔','以前','あの時'];
  const futureK = ['明日','来週','これから','将来','今後','予定'];

  const has = (keys: string[]) => keys.some(k => t.includes(k.toLowerCase()));

  const target = has(selfK) ? 'self' : has(otherK) ? 'other' : has(taskK) ? 'task' : 'self';
  const valence = has(approachK) ? 'approach' : has(avoidK) ? 'avoid' : 'neutral';
  const timescale = has(pastK) ? 'past' : has(futureK) ? 'future' : 'present';
  const actionability = valence === 'approach' ? 'high' : valence === 'avoid' ? 'low' : 'medium';

  const confidence =
    (target !== 'self' ? 0.2 : 0) +
    (valence !== 'neutral' ? 0.2 : 0) +
    (timescale !== 'present' ? 0.1 : 0) + 0.5;

  return {
    target, valence, timescale, actionability,
    confidence: Math.min(0.95, confidence)
  };
}
