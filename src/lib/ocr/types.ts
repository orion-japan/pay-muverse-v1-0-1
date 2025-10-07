/* src/lib/ocr/types.ts */

/** ラベル付け後の話者 */
export type Speaker = 'self' | 'partner';

/** 画面上の左右ヒント */
export type Side = 'left' | 'right';

/** テキストブロック（OCRの最小単位） */
export interface OcrBlock {
  text: string;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  /** x 座標中心（正規化前でもOK） */
  xCenter?: number;
  /** ページ番号（未使用なら省略可） */
  page?: number;
}

/** extractMessages が返す最小“吹き出し”構造（幾何のみ） */
export interface OcrMessage {
  text: string;
  xCenter: number;
  yTop: number;
  width: number;
  height: number;
  page: number;
}

/** 会話一文のラベル付き構造（左右＝話者推定を含む） */
export interface LabeledMessage {
  text: string;
  /** 垂直位置（描画順の参考。無ければ 0〜1 で擬似値） */
  yTop?: number;
  yBottom?: number;
  /** ブロック中心 x。無ければ 0.5 などで擬似値 */
  xCenter?: number;
  /** 推定された話者 */
  side: Speaker;
  /** 推定確度 0..1 */
  confidence: number;
}

/** 左右判定のためのオプション */
export interface AnalyzeChatOptions {
  /** 会話で「自分」が右側かどうか（true: 右／false: 左） */
  selfIsRight?: boolean;
  /** UI配置などからのヒント（'left' | 'right'） */
  selfSideHint?: Side;
}

/** OCR パイプラインのオプション（分析オプションを継承） */
export interface OcrPipelineOptions extends AnalyzeChatOptions {
  /** 画像の上下トリミング比率。未指定なら 0（トリミング無し） */
  cropRatio?: number;
  /** Tesseract 言語。未指定なら 'jpn+eng' */
  lang?: string;
}

/** パイプラインの最終結果 */
export interface OcrResult {
  /** 生テキスト（全ページ連結） */
  rawText: string;
  /** 1ページごとの生テキスト */
  pages: string[];
  /** ラベル付けされた会話（簡易） */
  labeled: LabeledMessage[];
}
