// 全エージェント共通の文末整形ユーティリティ
import clarifyPhrasing from './phrasing';

export function ensureDeclarativeClose(text: string): string {
  const clarified = clarifyPhrasing(text);
  return clarified.replace(/[。.\s]+$/g, '') + '。';
}
