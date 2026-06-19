import type { MemoryIntent } from './types';

function isProjectOrNonPersonContext(text: string): boolean {
  return /(Muverse|Moodle|PAY\.JP|Supabase|Firebase|Cloudflare|Zoho|Git|GitHub|Next\.js|route\.ts|コード|PowerShell|typecheck|npm|実装|修正|改修|エラー|ビルド|デプロイ|PR|コミット|API|SQL|ファイル|関数|アプリ|サービス|事業|プロジェクト|プロダクト|サイト|LP|導線|課金|登録|ユーザー|継続利用|拡散|SNS|投稿|分析|自動化|ステップメール|マーケ|集客|リリース|ローンチ|完成度|品質|仕様書|書類|資料|PDF|docx|文書|原稿|レポート|特許書類|画像|動画|プロンプト|VEO|Seedance|Kling|花火|台本|デザイン)/iu.test(text);
}

function isObservationFollowupToProject(text: string): boolean {
  return /(?:それ|これ|この話|その話|先ほど|さっき|同じ|比較|つまり|なんで|なぜ|理由|根拠|詳しく|もう少し|品質|レベル)/u.test(text) &&
    /(?:なんでわかるの|なぜわかる|返信|返答|品質|実務|タイミング|導線|課金|拡散|アプリ|Muverse|プロジェクト|事業)/iu.test(text);
}

export function classifyMemoryIntent(userText: string): MemoryIntent {
  const text = String(userText ?? '').trim();

  if (!text) return 'unknown';

  if (/スクショ診断\s*ID[:：]?\s*\d+|スクショ診断\s*\d+/u.test(text)) {
    return 'screenshot_diagnosis_recall';
  }

  if (/(ir診断|IR診断|意図診断|診断結果|前の診断|診断の続き|診断を深め|診断を見て)/u.test(text)) {
    return 'ir_diagnosis_recall';
  }

  const projectLike = isProjectOrNonPersonContext(text) || isObservationFollowupToProject(text);

  // 人物の確定事実確認
  // 例: 対象人物Aは何歳だったっけ？ / 対象人物Aの誕生日は？
  // ここでは答えず、Person Context 側で再検索してから判断する。
  const personNameLike =
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん|氏)?(?:は|には|の).*(何歳|年齢|誕生日|生年月日|歳|いくつ|幾つ|子供|子ども|お子さん|息子|娘|家族構成)/u.test(text);

  const ageFactQuestionLike =
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん|氏)?(?:は|の).*(何歳|年齢|誕生日|生年月日|歳|いくつ|幾つ)/u.test(text) ||
    /(何歳|年齢|誕生日|生年月日|歳|いくつ|幾つ).*(だったっけ|でしたっけ|だっけ|ですか|かな)/u.test(text);

  const childrenFactQuestionLike =
    /(子供|子ども|お子さん|息子|娘|家族構成).*(いますか|いる\?|いる？|いるの|何人|ありますか|ある\?|ある？|ですか|かな|だっけ|でしたっけ)/u.test(text) ||
    /(いますか|いる\?|いる？|いるの|何人|ありますか|ある\?|ある？|ですか|かな|だっけ|でしたっけ).*(子供|子ども|お子さん|息子|娘|家族構成)/u.test(text);

  const explicitQuestionLike =
    /[?？]|(いますか|いるの|いる？|います？|ありますか|ある？|何人|何歳|だっけ|でしたっけ|ですか|でしょうか|かな)/u.test(text);

  const personFactAssertionLike =
    !explicitQuestionLike &&
    (
      /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん|氏)?(?:は|には|の).*(子供|子ども|お子さん|息子|娘|長男|長女|次男|次女).*(いる|いて|います|です|だ|だった|名前は|名前が)/u.test(text) ||
      /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん|氏)?(?:は|には|の).*(この前の誕生日|誕生日で|歳になった|歳です|歳だ)/u.test(text)
    );

  const personFactQuestionLike =
    !personFactAssertionLike &&
    (
      personNameLike ||
      ageFactQuestionLike ||
      childrenFactQuestionLike
    );

  if (!projectLike && personFactQuestionLike) {
    return 'person_state_recall';
  }

  // 人物名・ニックネーム + 情報整理
  // 例: 対象人物Aの情報をまとめてください / 対象人物Aについて教えて
  if (
    !projectLike &&
    /([一-龠ぁ-んァ-ンA-Za-z0-9_ー]{1,24})(さん|先生|様|くん|ちゃん)?(?:の|について)(?:情報|こと|状態|現在地|文脈|メモ|プロフィール|話|要点|流れ|背景).*(まとめ|整理|教えて|確認|見せて|ありますか|あります)?/u.test(text)
  ) {
    return 'person_state_recall';
  }

  // Observation Lock: プロジェクト・技術・文書・制作の話題では、
  // 「関係」「状態」「進捗」などの一般語だけで Person/Relationship に飛ばさない。
  if (!projectLike && !personFactAssertionLike && /(関係|距離感|仲|相性|恋愛|彼|彼女|相手|夫|妻|母|父|子供|友達|クライアント|先生|弟子)/u.test(text)) {
    return 'relationship_recall';
  }

  if (!projectLike && !personFactAssertionLike && /(今どういう状態|現在地|どこにいる|状態|進捗|行き先|方向|ズレ|成長|移行中|定着)/u.test(text)) {
    return 'person_state_recall';
  }

  if (projectLike) {
    return 'project_context_recall';
  }

  if (/(前者|後者|一つ目|二つ目|1で|2で|それで|それを|お願いします|続けて|はい)/u.test(text) && text.length <= 30) {
    return 'pending_offer_followup';
  }

  if (/(続き|さっき|この件|その件|あの件|もう少し|詳しく|それは|これは)/u.test(text)) {
    return 'active_thread_followup';
  }

  if (/(前のルール|作業ルール|いつものルール|覚えて|設定|仕様|方針)/u.test(text)) {
    return 'working_rule_recall';
  }

  return 'normal_chat';
}
