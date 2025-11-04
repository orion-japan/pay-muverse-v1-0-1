export type Phase = 'initial' | 'mid' | 'final';
export type Stage = 'S' | 'F' | 'R' | 'C' | 'I';

export type Status = '検討中' | '実践中' | '迷走中' | '順調' | 'ラストスパート' | '達成' | '破棄';

export interface Vision {
  vision_id?: string;
  phase: Phase;
  stage: Stage;
  title: string;
  detail?: string;
  intention?: string;
  supplement?: string;
  status?: Status;
  summary?: string;
  iboard_post_id?: string | null;
  iboard_thumb?: string | null; // クライアント表示用
  q_code?: any;
}
