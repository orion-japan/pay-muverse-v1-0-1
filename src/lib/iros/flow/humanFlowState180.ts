// src/lib/iros/flow/humanFlowState180.ts
//
// iros — Human Flow State 180 detail catalog
//
// 役割:
// - flow180.ts の short / resonance では持たない、人間状態の詳細指標を持つ
// - currentFlow / secondFlow から innerState / actionGuide / replyFocus を引く
// - humanStateTransfer.ts の TRANSFER_SEED に、人間状態の具体指針を渡す
//
// 方針:
// - flow180.ts は軽量ラベル正本のまま維持する
// - 長文の人間状態定義はこのファイルへ分離する
// - まず頻出状態から段階投入し、最終的に180状態すべてへ拡張する

import type { FlowStateId } from './flow180';

export type HumanFlowState180Entry = {
  id: FlowStateId;
  innerState: string;
  actionGuide: string;
  replyFocus: string;
};

const HUMAN_FLOW_STATE_180: Partial<Record<FlowStateId, HumanFlowState180Entry>> = {
  'e3-R1-neg': {
    id: 'e3-R1-neg',
    innerState:
      '相手の反応によって、自分の安心が大きく揺れている。まだ確認できていないことを、悪い意味として受け取りやすい。',
    actionGuide:
      '相手の反応を、自分の価値や関係の結論に直結させない。今わかっている事実へ戻す。',
    replyFocus:
      '相手の反応で揺れた安心を、事実へ戻す。',
  },

  'e4-I1-neg': {
    id: 'e4-I1-neg',
    innerState:
      '出来事の意味を、恐れや孤独の物語として受け取りやすい。まだ確認できていない空白に、不安な物語を入れやすい。',
    actionGuide:
      '出来事を怖い物語として決めつけない。今感じている恐れと、実際に起きていることを分ける。',
    replyFocus:
      '恐れの物語にしない。',
  },

  'e1-R1-neg': {
    id: 'e1-R1-neg',
    innerState:
      '相手の反応によって、自分の意思や安心が揺れている。相手に合わせすぎて、自分の本音を飲み込みやすい。',
    actionGuide:
      '相手の反応を、自分の価値や意思の正しさに直結させない。まず、自分が何を我慢しているのかを見る。',
    replyFocus:
      '相手の反応と自分の意思を分ける。',
  },

  'e3-S1-neg': {
    id: 'e3-S1-neg',
    innerState:
      '不安や違和感は出ているが、まだ自分の中心で受け止められていない。考えがまとまる前に、内側が乱れ始めている。',
    actionGuide:
      'まず、不安定になっていることを認める。理由を探しすぎる前に、自分の中心が揺れていることを見る。',
    replyFocus:
      '不安定さに気づき、中心へ戻す。',
  },

  'e2-I2-neg': {
    id: 'e2-I2-neg',
    innerState:
      '本当の意図より、怒り・不信・諦めが前に出やすい。育てたいものがあるのに、どうせ無理だという感覚に寄りやすい。',
    actionGuide:
      '不信を意図にしない。本当は何を育てたいのか、どこへ向かいたいのかを決める。',
    replyFocus:
      '不信ではなく、育てたい意図を定める。',
  },

  'e4-C3-neg': {
    id: 'e4-C3-neg',
    innerState:
      '外側の環境や関係の中で、自分の流れが通らず詰まっている。場に合わせすぎるか、圧力として受け取りすぎて苦しくなりやすい。',
    actionGuide:
      '通らないことを、自分の孤独や拒絶として決めつけない。場・相手・条件の中で、流れる形へ調整する。',
    replyFocus:
      '外界で流れる形へ整える。',
  },

  'e4-C3-pos': {
    id: 'e4-C3-pos',
    innerState:
      '自分の流れが、外側の場や関係の中で成立している状態。コミュニケーションが通り、自然に適応できている。',
    actionGuide:
      '場や相手を尊重しながら、自分の流れも通す。外側で成立するコミュニケーションの形にする。',
    replyFocus:
      '流れを外界で成立させる。',
  },
};

export function getHumanFlowState180(
  id: FlowStateId | null | undefined,
): HumanFlowState180Entry | null {
  if (!id) return null;
  return HUMAN_FLOW_STATE_180[id] ?? null;
}

export function hasHumanFlowState180(
  id: FlowStateId | null | undefined,
): id is FlowStateId {
  if (!id) return false;
  return Boolean(HUMAN_FLOW_STATE_180[id]);
}
