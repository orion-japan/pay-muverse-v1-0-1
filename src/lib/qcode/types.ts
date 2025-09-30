export type QRes = {
    ts: string; // ISO
    currentQ: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
    depthStage: 'S1'|'S2'|'S3'|'F1'|'F2'|'F3'|'R1'|'R2'|'R3'|'C1'|'C2'|'C3'|'I1'|'I2'|'I3'|'T1'|'T2'|'T3';
    phase: 'Inner'|'Outer';
    self: { score:number; band:'lt20'|'20_40'|'40_70'|'70_90'|'gt90' };
    relation: { label:'harmony'|'discord'|'neutral'; confidence:number };
    score?: number;                   // 0..1 信頼度（任意）
    hint?: string | null;             // 短い説明（任意）
    dist?: Partial<Record<'Q1'|'Q2'|'Q3'|'Q4'|'Q5', number>> | null; // 任意
    evidence?: string[] | null;       // 最大3語（任意）
    source?: { type:string; model?:string; version?:string } | null;
    conversation_id?: string | null;
    message_id?: string | null;
  };
  