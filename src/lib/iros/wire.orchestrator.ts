// src/lib/iros/wire.orchestrator.ts
// Iros — Orchestrator wiring（DB/LLM/テンプレを依存注入）
// - generate.ts は (Wire as any).makeOrchestrator() を呼び出します
// - 既存実装名の差異に耐えるため dynamic import 風フォールバックで束ねます

import { devlog, devwarn } from '@/lib/utils/devlog';
import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';

import * as IntentMod from './intent';
import * as FocusMod from './focusCore';
import * as BuildPromptMod from './buildPrompt';
import * as PhrasingMod from './phrasing';
import * as TitleMod from './title';

// 履歴・メモリ（名称が異なる環境に対応するシム）
import * as HistMod from './history.adapter';
import * as MemMod from './memory.adapter';
import * as MemCore from './memory';
import type { IrosMemory } from './types'; // ★ 追加

type Mode = 'diagnosis' | 'auto' | 'counsel' | 'structured';

type RunArgs = {
  conversationId: string;
  userCode?: string;
  text: string;
  mode?: Mode | string;
  extra?: Record<string, unknown>;
};

type RunResult = {
  reply: string;
  meta: {
    focus?: {
      phase?: string;
      depth?: string;
      q?: string;
      reasons?: string[];
    } | null;
    memory?: { summary?: string; keywords?: string[] } | null;
    timings?: Record<string, number>;
    tokens?: { prompt?: number; completion?: number; total?: number } | null;
  };
  messagesSaved?: number;
};

const DEBUG = process.env.IROS_DEBUG === '1';
const MODEL = process.env.IROS_MODEL || 'gpt-4o-mini';

/* ===== helpers: 動的フォールバック ===== */
const detectIntentMode: (t: string, hint?: any) => Mode =
  (IntentMod as any).detectIntentMode ?? ((t: string) => 'auto');

const analyzeFocus: (t: string) => any =
  (FocusMod as any).analyzeFocus ?? (() => null);

const buildPrompt: (args: {
  mode: Mode;
  text: string;
  history: ChatMessage[];
  memory: any;
  focus: any;
  extra?: any;
}) => Promise<{ system: string; messages: ChatMessage[] }> =
  (BuildPromptMod as any).buildPrompt ??
  (async (a: any) => ({
    system: '',
    messages: [
      ...(a.history ?? []),
      { role: 'user', content: String(a.text ?? '') },
    ],
  }));

const naturalClose: (t: string) => string =
  (PhrasingMod as any).naturalClose ?? ((t: string) => t);

const makeTitle: (t: string, f?: any, m?: any) => string =
  (TitleMod as any).makeTitle ?? (() => '');

const loadHistoryDB: (cid: string, limit: number) => Promise<ChatMessage[]> =
  (HistMod as any).loadHistoryDB ??
  (HistMod as any).loadHistory ??
  (async () => []);

/* ======================================================
 * メモリ読み書き（MemoryAdapter があればそちら優先）
 *  - 無ければ MemCore.getIrosMemory / saveIrosMemory をラップして使う
 * ====================================================== */

// ★ 修正版: getIrosMemory をそのまま使えるようにラップ
const loadMemorySnap: (cid: string) => Promise<IrosMemory | null> =
  (MemMod as any).MemoryAdapter?.load ??
  (async (cid: string) => {
    if (typeof (MemCore as any).getIrosMemory === 'function') {
      return (MemCore as any).getIrosMemory(cid);
    }
    return null;
  });

// ★ 修正版: saveIrosMemory の新しいシグネチャに合わせたラッパ
const saveMemorySnap: (
  cid: string,
  userCode: string,
  snap: any,
) => Promise<void> =
  (MemMod as any).MemoryAdapter?.save ??
  (async (cid: string, userCode: string, snap: any) => {
    if (typeof (MemCore as any).saveIrosMemory !== 'function') return;

    // snap から IrosMemory を安全に組み立てる
    const mem: IrosMemory = {
      summary: String(snap?.summary ?? ''),
      depth: String(snap?.depth ?? ''),
      tone: String(snap?.tone ?? ''),
      theme: String(snap?.theme ?? ''),
      last_keyword: String(snap?.last_keyword ?? ''),
    };

    await (MemCore as any).saveIrosMemory({
      conversationId: cid,
      user_code: userCode || 'system',
      mem,
    });
  });

const saveMessagesDB: (args: {
  conversationId: string;
  userText: string;
  assistantText: string;
  mode?: string;
  meta?: any;
}) => Promise<void> =
  (HistMod as any).saveMessagesDB ??
  (HistMod as any).saveMessages ??
  (async () => {});

/* ===== factory ===== */
export function makeOrchestrator(opts?: { debug?: boolean; model?: string }) {
  const debug = Boolean(opts?.debug ?? DEBUG);
  const model = String(opts?.model ?? MODEL);

  return {
    /** 1ターン生成（DB I/O + LLM + 後処理） */
    async run(args: RunArgs): Promise<RunResult> {
      const t0 = Date.now();
      const timings: Record<string, number> = {};

      const conversationId = String(args?.conversationId ?? '').trim();
      const text = String(args?.text ?? '').trim();
      if (!conversationId || !text) {
        throw new Error('bad_request: conversationId/text required');
      }

      // 1) mode
      const md0 = Date.now();
      const mode: Mode = (args?.mode as Mode) || detectIntentMode(text);
      timings.detect_mode_ms = Date.now() - md0;
      if (debug)
        devlog(
          'makeOrchestrator:mode',
          { mode },
          { scope: 'orchestrator', isServerOnly: true },
        );

      // 2) history
      const h0 = Date.now();
      // DB行を {role, content} へ正規化（null安全）
      const historyRows = (await loadHistoryDB(conversationId, 10).catch(
        () => [],
      )) as any[];
      const history: ChatMessage[] = (historyRows || [])
        .map(r => ({
          role: (r.role === 'assistant'
            ? 'assistant'
            : r.role === 'system'
            ? 'system'
            : 'user') as ChatMessage['role'],
          content: String((r.content ?? r.text ?? '') || ''),
        }))
        .filter(m => m.content.trim().length > 0);
      timings.load_history_ms = Date.now() - h0;

      // 3) memory
      const m0 = Date.now();
      const memory = await loadMemorySnap(conversationId).catch(() => null);
      timings.load_memory_ms = Date.now() - m0;

      // 4) focus
      const f0 = Date.now();
      const focus = analyzeFocus(text);
      timings.focus_ms = Date.now() - f0;

      // 5) prompt
      const p0 = Date.now();
      const { system, messages } = await buildPrompt({
        mode,
        text,
        history,
        memory,
        focus,
        extra: args?.extra,
      });
      timings.build_prompt_ms = Date.now() - p0;

      // 6) LLM
      const l0 = Date.now();
      const reply = await chatComplete({
        model,
        messages:
          messages && messages.length
            ? messages
            : ([
                system ? { role: 'system', content: system } : null,
                { role: 'user', content: text },
              ].filter(Boolean) as ChatMessage[]),
        temperature: 0.4,
        max_tokens: 640,
      });
      timings.llm_ms = Date.now() - l0;

      // 7) post-process
      const pp0 = Date.now();
      const closed = naturalClose(String(reply ?? ''));
      const title = makeTitle(text, focus ?? undefined, memory ?? undefined);
      timings.post_ms = Date.now() - pp0;

      // 8) persist
      const s0 = Date.now();
      try {
        await saveMessagesDB({
          conversationId,
          userText: text,
          assistantText: closed,
          mode,
          meta: { focus, memory, title },
        });

        await saveMemorySnap(conversationId, String(args?.userCode ?? ''), {
          ...(memory ?? {}),
          updated_at: new Date().toISOString(),
        });
      } catch (e) {
        devwarn(
          'persist:fail',
          String((e as Error)?.message || e),
          { scope: 'orchestrator', isServerOnly: true },
        );
      }
      timings.persist_ms = Date.now() - s0;

      timings.total_ms = Date.now() - t0;

      if (debug)
        devlog(
          'orchestrator.run:done',
          { mode, timings },
          { scope: 'orchestrator', isServerOnly: true },
        );

      return {
        reply: closed,
        meta: {
          focus: focus ?? null,
          memory: memory ?? null,
          timings,
          tokens: null,
        },
        messagesSaved: 2, // user/assistant の2件保存が既定
      };
    },
  };
}

export default makeOrchestrator;
