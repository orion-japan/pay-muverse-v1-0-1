// src/ui/iroschat/lib/irosApiClient.ts
'use client';

import * as irosClientModule from './irosTransport';
import { getAuth, type User } from 'firebase/auth';
import type { ResonanceState, IntentPulse } from '@/lib/iros/config';
import type { IrosConversation, IrosMessage, IrosUserInfo } from '../types';

/* ========= Iros 口調スタイル ========= */
/** ※ IrosChatContext.tsx の IrosStyle と必ず揃えること */
export type IrosStyle = 'friendly' | 'biz-soft' | 'biz-formal' | 'plain';

/* ========= history（LLMに渡す会話履歴） ========= */
export type IrosChatHistoryItem = {
  role: 'user' | 'assistant';
  content: string;
};

/* ========= DEV logger ========= */
const __DEV__ = process.env.NODE_ENV !== 'production';
const dbg = (...a: any[]) => {
  if (__DEV__) console.log('[IROS/API]', ...a);
};

/* ---- irosClient の暫定型定義（unknown撲滅） ---- */
export type IrosAPI = {
  createConversation(): Promise<{ conversationId: string }>;
  listConversations(): Promise<IrosConversation[]>;
  fetchMessages(conversationId: string): Promise<IrosMessage[]>;
  renameConversation(
    conversationId: string,
    title: string,
  ): Promise<{ ok: true } | void>;
  deleteConversation(conversationId: string): Promise<{ ok: true } | void>;
  /** ※ 残すが UI 側では使わない（/messages 直叩きは二重化の原因になるため） */
  postMessage(args: {
    conversationId: string;
    text: string;
    role?: 'user' | 'assistant';
    meta?: any;
  }): Promise<{ ok: true }>;

  /**
   * /reply を叩くだけ（整形しない / 保存しない）
   * - ここは「純粋にサーバ応答を返す」ことを保証する
   */
  reply(args: {
    conversationId?: string;
    user_text: string;
    mode?: 'Light' | 'Deep' | 'Transcend' | 'Harmony' | string;
    model?: string;
    resonance?: ResonanceState;
    intent?: IntentPulse;
    headers?: Record<string, string>; // 冪等キー付与用

    // 🗣 Iros の口調スタイル
    style?: IrosStyle;

    // ✅ 会話履歴（LLMへ渡す）
    history?: IrosChatHistoryItem[];

    // ★ ギア選択から渡す情報（任意）
    nextStepChoice?: {
      key: string;
      label: string;
      gear?: string | null;
    };
  }): Promise<any>;

  /**
   * /reply の戻りを正規化し、未保存なら assistant を保存する
   * - assistantRaw: 保存向け（最低限trimのみ）
   * - assistant: UI表示向け（句読点/🪔などの見栄え整形）
   */
  replyAndStore(args: {
    conversationId: string;
    user_text: string;
    mode?: string;
    model?: string;

    // 🗣 Iros の口調スタイル
    style?: IrosStyle;

    // ✅ 会話履歴（LLMへ渡す）
    history?: IrosChatHistoryItem[];

    // ★ ギア選択から渡す情報（任意）
    nextStepChoice?: {
      key: string;
      label: string;
      gear?: string | null;
    };
  }): Promise<{ assistant: string; assistantRaw: string } & Record<string, any>>;

  getUserInfo(): Promise<IrosUserInfo | null>;
};

// ====== フォールバックを含む irosClient ラッパー ======
//
// irosTransport.ts は `export default api;` を持つため、
// `.default ?? module` だと default を掴んでしまい、named exports（postMessage等）を見失うことがある。
// → ここでは "default" と "named exports" を合成して、常に必要な関数を拾えるようにする。
const _mod = irosClientModule as any;
const _raw = {
  ...(typeof _mod === 'object' && _mod ? _mod : {}),
  ...(typeof _mod?.default === 'object' && _mod.default ? _mod.default : {}),
} as Record<string, any>;


/**
 * Firebase Auth の currentUser が有効になるまで待つ。
 * 最大 timeoutMs ミリ秒待って、それでもいなければ null を返す。
 */
async function waitForCurrentUser(timeoutMs = 3000): Promise<User | null> {
  const auth = getAuth();
  const start = Date.now();

  if (auth.currentUser) return auth.currentUser;

  while (!auth.currentUser && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }

  return auth.currentUser ?? null;
}

/**
 * 認証付き fetch
 * - currentUser が準備できるまで待機
 * - user が取れない場合はサーバに投げずにエラーを投げる
 */
async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  const cred: RequestCredentials = init.credentials ?? 'include';

  // ---- Firebase currentUser を待つ ----
  const user = await waitForCurrentUser();

  if (!user) {
    const err = new Error('401 not_authenticated: firebase currentUser is null');
    if (__DEV__) console.warn('[IROS/API] authFetch no currentUser', err.message);
    throw err;
  }

  // ---- ID トークン取得（まずはキャッシュ）----
  const token = await user.getIdToken(false).catch(() => null);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // JSON 基本
  if (!headers.has('Content-Type') && init.method && init.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(input, {
    ...init,
    headers,
    credentials: cred,
    cache: 'no-store',
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (__DEV__) console.warn('[IROS/API] authFetch error', res.status, t);
    throw new Error(`HTTP ${res.status} ${t}`);
  }
  return res;
}

/**
 * 認証系 API 用のリトライラッパー
 */
export async function retryAuth<T>(
  fn: () => Promise<T>,
  opt: { tries?: number; baseMs?: number } = {},
): Promise<T> {
  const tries = opt.tries ?? 6;
  const baseMs = opt.baseMs ?? 500;
  let lastErr: any;

  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const isAuth =
        /\b(401|403)\b/.test(msg) ||
        /unauthorized/i.test(msg) ||
        /forbidden/i.test(msg);
      if (!isAuth && i >= 1) break;
      const wait = baseMs * Math.pow(1.8, i);
      dbg('retryAuth backoff', { i, wait, msg });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/* =========================
 * Reply helpers（責務境界の固定）
 * ========================= */

function toStr(v: any): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

/** サーバ応答から assistant 本文候補を抽出（保存用：最小限trimのみ） */
function extractAssistantRaw(r: any): string {
  const t =
    // ✅ 新 iros の代表キー（最優先）
    r?.assistantText ??
    r?.text ??
    r?.content ??

    // 旧互換
    r?.assistant ??
    r?.reply ??
    r?.reply_text ??
    r?.message ??

    // OpenAI系
    r?.message?.content ??
    r?.choices?.[0]?.message?.content ??
    r?.output_text ??
    '';

  return toStr(t).trim();
}


/**
 * UI表示用の整形（※保存用には使わない）
 * ✅ 重要: UIが勝手に返答を「生成」しない
 * - 空なら空を返す（沈黙を許す）
 * - 句読点や🪔の自動付与はしない（サーバ出力を尊重）
 */
function formatAssistantForUI(text: string): string {
  const t = toStr(text).trim();
  if (!t) return '';
  return t;
}

/** meta抽出（保存に使う） */
function extractMeta(r: any): any {
  return r?.meta ?? null;
}

/** サーバが保存したと判断できるフラグ */
function isServerPersisted(r: any): boolean {
  return !!(
    r?.saved ||
    r?.persisted ||
    r?.db_saved ||
    r?.message_id ||
    r?.messageId ||
    r?.message?.id
  );
}

// ====== Person-Intent 状態ビュー取得 ======

export type PersonIntentStateRow = {
  user_code: string;
  situation_topic: string | null;
  target_kind: string | null;
  target_label: string | null;
  conversation_id: string | null;
  last_created_at: string | null;
  last_q_code: string | null;
  last_depth_stage: string | null;
  last_self_acceptance: number | null;
  y_level: number | null;
  h_level: number | null;
};

/**
 * /api/intent/person-state を叩いて
 * 「ユーザーごとの意図状態（状況×対象）」一覧を取得する
 */
export async function fetchPersonIntentState(): Promise<PersonIntentStateRow[]> {
  return retryAuth(async () => {
    const res = await authFetch('/api/intent/person-state', {
      method: 'GET',
    });
    const j = await res.json();

    // 返却形式が「配列」または「{ rows: [...] }」のどちらでも動くようにしておく
    const rowsRaw = Array.isArray(j)
      ? j
      : Array.isArray(j?.rows)
        ? j.rows
        : [];

    return rowsRaw.map((r: any) => ({
      user_code: String(r.user_code),
      situation_topic: r.situation_topic != null ? String(r.situation_topic) : null,
      target_kind: r.target_kind != null ? String(r.target_kind) : null,
      target_label: r.target_label != null ? String(r.target_label) : null,
      conversation_id: r.conversation_id != null ? String(r.conversation_id) : null,
      last_created_at: r.last_created_at != null ? String(r.last_created_at) : null,
      last_q_code: r.last_q_code != null ? String(r.last_q_code) : null,
      last_depth_stage: r.last_depth_stage != null ? String(r.last_depth_stage) : null,
      last_self_acceptance:
        typeof r.last_self_acceptance === 'number'
          ? r.last_self_acceptance
          : r.last_self_acceptance != null
            ? Number(r.last_self_acceptance)
            : null,
      y_level:
        typeof r.y_level === 'number'
          ? r.y_level
          : r.y_level != null
            ? Number(r.y_level)
            : null,
      h_level:
        typeof r.h_level === 'number'
          ? r.h_level
          : r.h_level != null
            ? Number(r.h_level)
            : null,
    })) as PersonIntentStateRow[];
  });
}

/* ========= 実体 irosClient ========= */

export const irosClient: IrosAPI = {
  async createConversation() {
    if (typeof _raw.createConversation === 'function') return _raw.createConversation();
    dbg('createConversation() fallback');
    const r = await authFetch('/api/agent/iros/conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', title: '新しい会話' }),
    });
    const j = await r.json();
    const id = String(j.conversationId || j.id || '');
    dbg('createConversation ->', id);
    return { conversationId: id };
  },

  async listConversations() {
    if (typeof _raw.listConversations === 'function') return _raw.listConversations();
    dbg('listConversations() fallback');
    const r = await authFetch('/api/agent/iros/conversations', {
      method: 'GET',
    });
    const j = await r.json();
    const arr = Array.isArray(j?.conversations) ? j.conversations : [];
    return arr.map((c: any) => ({
      id: String(c.id),
      title: String(c.title ?? '新規セッション'),
      created_at: c.created_at ?? null,
      updated_at: c.updated_at ?? c.created_at ?? null,
      agent: c.agent ?? 'iros',
    })) as IrosConversation[];
  },

  async fetchMessages(conversationId: string) {
    if (typeof _raw.fetchMessages === 'function') return _raw.fetchMessages(conversationId);
    dbg('fetchMessages() fallback', conversationId);

    const r = await authFetch(
      `/api/agent/iros/messages?conversation_id=${encodeURIComponent(conversationId)}&include_meta=1`,
    );

    const j = await r.json();
    const rows = Array.isArray(j?.messages) ? j.messages : [];

    return rows.map((m: any) => {
      const metaSafe =
        m.meta && typeof m.meta === 'object' && !Array.isArray(m.meta)
          ? { ...m.meta }
          : null;

      const qSafe = m.q_code ?? m.q ?? null;
      const depthSafe = m.depth_stage ?? null;
      const intentLayerSafe = m.intent_layer ?? null;

      const mergedMeta =
        metaSafe != null
          ? {
              ...metaSafe,
              qCode: metaSafe.qCode ?? metaSafe.q_code ?? qSafe ?? null,
              q_code: metaSafe.q_code ?? metaSafe.qCode ?? qSafe ?? null,
              q: metaSafe.q ?? qSafe ?? null,
              depth:
                metaSafe.depth ??
                metaSafe.depthStage ??
                metaSafe.depth_stage ??
                depthSafe ??
                null,
              depthStage:
                metaSafe.depthStage ??
                metaSafe.depth_stage ??
                metaSafe.depth ??
                depthSafe ??
                null,
              depth_stage:
                metaSafe.depth_stage ??
                metaSafe.depthStage ??
                metaSafe.depth ??
                depthSafe ??
                null,
              intentLayer:
                metaSafe.intentLayer ??
                metaSafe.intent_layer ??
                intentLayerSafe ??
                null,
              intent_layer:
                metaSafe.intent_layer ??
                metaSafe.intentLayer ??
                intentLayerSafe ??
                null,
            }
          : {
              qCode: qSafe,
              q_code: qSafe,
              q: qSafe,
              depth: depthSafe,
              depthStage: depthSafe,
              depth_stage: depthSafe,
              intentLayer: intentLayerSafe,
              intent_layer: intentLayerSafe,
            };

      return {
        id: String(m.id),
        role: (m.role === 'assistant'
          ? 'assistant'
          : m.role === 'system'
            ? 'system'
            : 'user') as IrosMessage['role'],
        text: String(m.content ?? m.text ?? ''),
        content: String(m.content ?? m.text ?? ''),
        created_at: m.created_at ?? null,
        ts: m.ts ? Number(m.ts) : new Date(m.created_at || Date.now()).getTime(),
        meta: mergedMeta,

        // reload後も UI バッジで使う列値を保持
        q_code: qSafe,
        qCode: qSafe,
        q: qSafe,
        color: m.color ?? null,
        depth_stage: depthSafe,
        depthStage: depthSafe,
        depth: depthSafe,
        intent_layer: intentLayerSafe,
        intentLayer: intentLayerSafe,
      };
    }) as IrosMessage[];
  },

  async renameConversation(conversationId: string, title: string) {
    if (typeof _raw.renameConversation === 'function')
      return _raw.renameConversation(conversationId, title);
    dbg('renameConversation() fallback', conversationId, title);
    await authFetch('/api/agent/iros/conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'rename', id: conversationId, title }),
    });
    return { ok: true as const };
  },

  async deleteConversation(conversationId: string) {
    if (typeof _raw.deleteConversation === 'function') return _raw.deleteConversation(conversationId);
    dbg('deleteConversation() fallback', conversationId);
    await authFetch('/api/agent/iros/conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', id: conversationId }),
    });
    return { ok: true as const };
  },

  async postMessage(args: {
    conversationId: string;
    text: string;
    role?: 'user' | 'assistant';
    meta?: any;
  }) {
    if (typeof _raw.postMessage === 'function') return _raw.postMessage(args);
    dbg('postMessage() fallback', {
      len: args.text?.length,
      role: args.role,
    });
    await authFetch('/api/agent/iros/messages', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: args.conversationId,
        text: args.text,
        role: args.role ?? 'user',
        meta: args.meta ?? null,
      }),
    });
    return { ok: true as const };
  },

  async reply(args) {
    if (typeof _raw.reply === 'function') return _raw.reply(args);

    dbg('reply() fallback', {
      mode: args.mode,
      hasCid: !!args.conversationId,
      style: args.style,
      history_len: args.history?.length ?? 0,
    });

    dbg('reply() body', {
      conversationId: args.conversationId,
      user_text: args.user_text,
      style: args.style,
      styleHint: args.style,
      hasHistory: Array.isArray(args.history),
      history_len: args.history?.length ?? 0,
    });

    const w = typeof window !== 'undefined' ? (window as any) : undefined;

    // reply() は「サーバへ投げるだけ」に固定（整形も保存もしない）
    const r = await authFetch('/api/agent/iros/reply', {
      method: 'POST',
      headers: args.headers ?? undefined,
      body: JSON.stringify({
        conversationId: args.conversationId,

        // ✅ 正規キー（サーバが確実に拾う）
        user_text: args.user_text,
        modeHint: args.mode ?? 'auto',
        styleHint: args.style ?? undefined,
        history: Array.isArray(args.history) ? args.history : undefined,

        // ✅ 互換（残してOK）
        text: args.user_text,
        mode: args.mode ?? 'auto',
        style: args.style ?? undefined,

        model: args.model,
        resonance: w?.__iros?.resonance ?? args.resonance,
        intent: w?.__iros?.intent ?? args.intent,
        nextStepChoice: args.nextStepChoice ?? undefined,
      }),
    });

    return r.json();
  },


// src/ui/iroschat/lib/irosApiClient.ts
// replyAndStore()：client-side の assistant 保存を撤去（single-writer: /reply のみ）

async replyAndStore(args) {
  if (typeof _raw.replyAndStore === 'function') {
    return _raw.replyAndStore(args);
  }

  const r: any = await this.reply({
    conversationId: args.conversationId,
    user_text: args.user_text,
    mode: args.mode ?? 'Light',
    model: args.model,
    style: args.style,
    history: args.history,
    nextStepChoice: args.nextStepChoice,
  });

  const assistantRaw = extractAssistantRaw(r);
  const assistant = formatAssistantForUI(assistantRaw);
  const meta = extractMeta(r);

  // =========================================================
  // ✅ single-writer 徹底
  // - assistant の永続化はサーバ（/api/agent/iros/reply）だけが行う
  // - クライアントから /api/agent/iros/messages に role='assistant' を POST しない
  //   → /messages は user-only (assistant HARD-SKIP) なので、やると「リロードで消える」を再発させる
  // =========================================================
  const serverPersisted = isServerPersisted(r);
  if (!serverPersisted) {
    dbg('replyAndStore: server did not mark persisted (client will NOT persist assistant)', {
      conversationId: args.conversationId,
      assistantRawLen: String(assistantRaw ?? '').length,
      hasMeta: !!meta,
    });
  }

  // 返すのは「UI表示用 + raw」
  return { ...r, assistant, assistantRaw };
},


async getUserInfo() {
  if (typeof _raw.getUserInfo === 'function') return _raw.getUserInfo();
  dbg('getUserInfo() fallback');
  const r = await authFetch('/api/agent/iros/userinfo', {
    method: 'GET',
  });
  const j = await r.json();
  const u = j?.user;
  if (!u) return { id: 'me', name: 'You', userType: 'member', credits: 0 };
  return {
    id: String(u.id ?? 'me'),
    name: String(u.name ?? 'You'),
    userType: String(u.userType ?? 'member'),
    credits: Number(u.credits ?? 0),
  };
},
};

