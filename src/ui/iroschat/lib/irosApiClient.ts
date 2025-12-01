// src/ui/iroschat/lib/irosApiClient.ts
'use client';

import * as irosClientModule from './irosClient';
import { getAuth, type User } from 'firebase/auth';
import type { ResonanceState, IntentPulse } from '@/lib/iros/config';
import type { IrosConversation, IrosMessage, IrosUserInfo } from '../types';

/* ========= Iros 口調スタイル ========= */
/** ※ IrosChatContext.tsx の IrosStyle と必ず揃えること */
export type IrosStyle = 'friendly' | 'biz-soft' | 'biz-formal' | 'plain';

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
  deleteConversation(
    conversationId: string,
  ): Promise<{ ok: true } | void>;
  /** ※ 残すが UI 側では使わない（/messages 直叩きは二重化の原因になるため） */
  postMessage(args: {
    conversationId: string;
    text: string;
    role?: 'user' | 'assistant';
  }): Promise<{ ok: true }>;
  reply(args: {
    conversationId?: string;
    user_text: string;
    mode?: 'Light' | 'Deep' | 'Transcend' | 'Harmony' | string;
    model?: string;
    resonance?: ResonanceState;
    intent?: IntentPulse;
    headers?: Record<string, string>; // 冪等キー付与用

    // 🗣 追加：Iros の口調スタイル
    style?: IrosStyle;
  }): Promise<
    | { ok: boolean; message?: { id?: string; content: string } } // 旧フォーマット
    | {
        ok: boolean;
        assistant?: string;
        mode?: string;
        systemPrompt?: string;
      } // 新フォーマット
  >;
  /** /reply の戻りを正規化し、未保存なら assistant を保存する */
  replyAndStore(args: {
    conversationId: string;
    user_text: string;
    mode?: string;
    model?: string;

    // 🗣 追加：Iros の口調スタイル
    style?: IrosStyle;
  }): Promise<{ assistant: string } & Record<string, any>>;
  getUserInfo(): Promise<IrosUserInfo | null>;
};

// ====== フォールバックを含む irosClient ラッパー ======
const _raw = ((irosClientModule as any).default ??
  irosClientModule) as Record<string, any>;

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
    const err = new Error(
      '401 not_authenticated: firebase currentUser is null',
    );
    if (__DEV__)
      console.warn('[IROS/API] authFetch no currentUser', err.message);
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

/* ========= 実体 irosClient ========= */

export const irosClient: IrosAPI = {
  async createConversation() {
    if (typeof _raw.createConversation === 'function')
      return _raw.createConversation();
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
    if (typeof _raw.listConversations === 'function')
      return _raw.listConversations();
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
    if (typeof _raw.fetchMessages === 'function')
      return _raw.fetchMessages(conversationId);
    dbg('fetchMessages() fallback', conversationId);
    const r = await authFetch(
      `/api/agent/iros/messages?conversation_id=${encodeURIComponent(
        conversationId,
      )}`,
    );
    const j = await r.json();
    const rows = Array.isArray(j?.messages) ? j.messages : [];
    return rows.map((m: any) => ({
      id: String(m.id),
      role: (m.role === 'assistant'
        ? 'assistant'
        : m.role === 'system'
        ? 'system'
        : 'user') as IrosMessage['role'],
      text: String(m.content ?? m.text ?? ''),
      content: String(m.content ?? m.text ?? ''),
      created_at: m.created_at ?? null,
      ts: m.ts
        ? Number(m.ts)
        : new Date(m.created_at || Date.now()).getTime(),
      meta: m.meta ?? null,
    })) as IrosMessage[];
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
    if (typeof _raw.deleteConversation === 'function')
      return _raw.deleteConversation(conversationId);
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
    });
    const r = await authFetch('/api/agent/iros/reply', {
      method: 'POST',
      headers: args.headers ?? undefined,
      body: JSON.stringify({
        conversationId: args.conversationId,
        text: args.user_text, // user_text → text
        modeHint: args.mode ?? 'Light',
        mode: args.mode ?? 'Light',
        history: [],
        model: args.model,
        resonance: (window as any)?.__iros?.resonance ?? args.resonance,
        intent: (window as any)?.__iros?.intent ?? args.intent,

        // 🗣 サーバー側へスタイルヒントとして渡す
        styleHint: args.style,
      }),
    });
    return r.json();
  },

  async replyAndStore(args) {
    if (typeof _raw.replyAndStore === 'function') {
      return _raw.replyAndStore(args);
    }

    const r: any = await this.reply({
      conversationId: args.conversationId,
      user_text: args.user_text,
      mode: args.mode ?? 'Light',
      model: args.model,

      // 🗣 ここでも style を引き継ぐ
      style: args.style,
    });

    // 正規化
    let t =
      r?.assistant ??
      r?.message?.content ??
      r?.choices?.[0]?.message?.content ??
      r?.output_text ??
      '';

    if (typeof t !== 'string') t = String(t ?? '');
    t = (t ?? '').trim();
    if (t && !/[。！？!?🪔]$/.test(t)) t += '。';
    if (t) t = t.replace(/🪔+/g, '') + '🪔';
    const safe = t || 'はい。🪔';

    const serverPersisted =
      !!(r?.saved ||
      r?.persisted ||
      r?.db_saved ||
      r?.message_id ||
      r?.messageId);

    if (!serverPersisted) {
      await this.postMessage({
        conversationId: args.conversationId,
        text: safe,
        role: 'assistant',
      });
    }
    return { ...r, assistant: safe };
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
