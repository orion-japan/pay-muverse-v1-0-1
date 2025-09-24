export type Agent = 'mu' | 'iros' | 'mirra';
export type Role = 'user' | 'assistant' | 'system';

export type Message = {
  id: string;
  role: Role;
  content: string;
  created_at?: string;
  isPreview?: boolean;
  meta?: any;
  free?: boolean;
  agent?: string;
};

export type ConvListItem = {
  id: string;
  title: string;
  updated_at?: string | null;
};

export type SofiaGetList = {
  items?: {
    conversation_code: string;
    title?: string | null;
    updated_at?: string | null;
    messages?: { role: Role; content: string }[];
  }[];
};
export type SofiaGetMessages = { messages?: { role: Role; content: string }[] };

export type MetaData = {
  qcodes?: any[];
  layers?: any[];
  used_knowledge?: any[];
  stochastic?: {
    on: boolean;
    g?: number | null;
    seed?: number | null;
    noiseAmp?: number | null;
    epsilon?: number | null;
    retrNoise?: number | null;
    retrSeed?: number | null;
  };
};
