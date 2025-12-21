// src/lib/mui/prompt.ts
import type { ConversationStage } from './types';

/** “言い切り”の種文＋既定chips＋質問（LLMに渡すヒント） */
export function phaseTemplate(phase: ConversationStage) {
  switch (phase) {
    case 1:
      return {
        seed: '主旋律は不安と悔しさ。体の信号は胸の重さ。ここから不安→信頼へ調律します。',
        chips: ['悲しい', '悔しい', '不安'],
        question: 'いちばん近い感情はどれですか？',
      };
    case 2:
      return {
        seed: '事実は連絡回数とタイミング／返信遅延の有無。最有力仮説は多忙由来の遅延です。',
        chips: ['朝', '昼', '夜'],
        question: 'その日の連絡の回数とタイミングは？',
      };
    case 3:
      return {
        seed: '現状は投影＋干渉が主体。自己不安の反射と正しさの押し出しが同時に走っています。',
        chips: ['投影', '干渉', '逃避'],
        question: 'しっくり来るのはどれですか？',
      };
    case 4:
      return {
        seed: 'このままなら温度は緩やかに低下。今週の一歩は遅延時の連絡ルールを先出し合意。',
        chips: ['ルール合意', '頻度調整', '一旦距離'],
        question: '最初の一歩を1文でどうしますか？',
      };
  }
}
