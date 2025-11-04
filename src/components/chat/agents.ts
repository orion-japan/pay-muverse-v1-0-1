// src/components/chat/agents.ts
// チャットで利用可能なエージェントの一覧に Mu を追加

import { MU_AGENT, MU_UI_TEXT } from '@/lib/mu/config';

export type ChatAgent = {
  id: string;
  title: string;
  description: string;
  version?: string;
};

export const chatAgents: ChatAgent[] = [
  {
    id: MU_AGENT.ID,
    title: MU_UI_TEXT.AGENT_DISPLAY_NAME,
    description: MU_UI_TEXT.AGENT_DESC,
    version: MU_AGENT.VERSION,
  },
  // 他のエージェント (例: iros, sofia など) をここに追加
];
