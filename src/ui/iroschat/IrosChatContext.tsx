// src/ui/iroschat/IrosChatContext.tsx
'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { irosClient } from './lib/irosApi';
import type { IrosStyle } from './lib/irosApi';
import type { IrosMessage, IrosConversation, IrosUserInfo } from './types';
import { auth } from '@/lib/firebase';
import { devlog, devwarn } from '@/lib/utils/devlog';

type SendResult =
  | {
      assistant: string;
      meta?: any;
    }
  | null;

  type IrosChatContextType = {
    loading: boolean;
    messages: IrosMessage[];
    conversations: IrosConversation[];
    userInfo: IrosUserInfo | null;

    /** 引用・入力補助用 draft */
    draftText: string;
    setDraftText: (text: string) => void;

    /** UI表示用（state） */
    activeConversationId: string | null;

    /** ✅ ロジック用（refを正とする） */
    getActiveConversationId: () => string | null;

    /** 現在の Iros 口調スタイル（settings で選択されたもの） */
    style: IrosStyle;

        /** Header 用の最新メタ */
        currentMeta: any;
        lastMeta: any;
        meta: any;

    fetchMessages: (cid: string) => Promise<void>;

    // 通常のチャット送信
    sendMessage: (text: string, mode?: string) => Promise<SendResult>;

    // ★ ギア選択（nextStep ボタン）からの送信
    sendNextStepChoice: (opt: {
      key: string;
      label: string;
      gear?: string | null;
    }) => Promise<SendResult>;

    // ★ Future-Seed 用（T層デモ）
    sendFutureSeed: () => Promise<SendResult>;

    // 既存
    startConversation: () => Promise<string>;
    renameConversation: (cid: string, title: string) => Promise<void>;
    deleteConversation: (cid: string) => Promise<void>;
    reloadConversations: () => Promise<void>;
    reloadUserInfo: () => Promise<void>;

    // 新しいチャット制御用（Shell / Header から呼ぶ想定）
    newConversation: () => Promise<string>;
    selectConversation: (cid: string) => Promise<void>;
  };

const IrosChatContext = createContext<IrosChatContextType | null>(null);

export const useIrosChat = () => useContext(IrosChatContext)!;

const STYLE_STORAGE_KEY = 'iros.style';

/**
 * ✅ サーバーから返ってくる message.text が object になっても、
 * UI に meta ダンプが表示されないように「必ず文字列」に正規化する。
 */
function normalizeText(t: unknown): string {
  if (typeof t === 'string') return t;
  if (t == null) return '';

  // object の場合、よくあるキーを優先して拾う
  if (typeof t === 'object') {
    const o = t as any;

    if (typeof o.assistant === 'string') return o.assistant;
    if (typeof o.reply === 'string') return o.reply;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.content === 'string') return o.content;
    if (typeof o.text === 'string') return o.text;

    // それでもダメなら「表示しない」（ここが重要）
    return '';
  }

  // number / boolean などは文字列化
  try {
    return String(t);
  } catch {
    return '';
  }
}

function normalizeMessages(rows: IrosMessage[]): IrosMessage[] {
  return (rows || []).map((m) => {
    const t = normalizeText((m as any)?.text);
    const c = normalizeText((m as any)?.content ?? (m as any)?.text);

    return {
      ...m,
      text: t,
      content: c || t,
    } as IrosMessage;
  });
}

function isUuidLike(value: string | null | undefined): value is string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? '').trim(),
  );
}

function replaceUrlCid(cid: string) {
  if (typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  url.searchParams.set('cid', cid);
  url.searchParams.set('agent', 'iros');
  window.history.replaceState(null, '', url.toString());
}
/**
 * LLMに渡す history を組み立てる（UI側で必要な場合の互換ヘルパー）
 * ✅ role は user/assistant のみに限定する（system を混ぜない）
 */
function buildHistoryForLLM(
  msgs: IrosMessage[],
  limitPairs: number = 10,
): { role: 'user' | 'assistant'; content: string }[] {
  // ✅ UI方針：history には assistant の本文だけ入れる（userText は絶対入れない）
  const cleaned = (msgs || [])
    .map((m) => {
      const roleRaw = (m as any)?.role;
      if (roleRaw !== 'assistant') return null;

      const content = normalizeText((m as any)?.content ?? (m as any)?.text).trim();
      if (!content) return null;

      return { role: 'assistant' as const, content };
    })
    .filter(
      (x): x is { role: 'assistant'; content: string } =>
        !!x && x.content.trim().length > 0,
    );

  // limitPairs は互換のため維持（実質 “assistant turns” の上限として効く）
  const max = Math.max(2, limitPairs * 2);
  return cleaned.slice(-max);
}

export const IrosChatProvider = ({ children }: { children: React.ReactNode }) => {
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<IrosMessage[]>([]);
  const [conversations, setConversations] = useState<IrosConversation[]>([]);
  const [userInfo, setUserInfo] = useState<IrosUserInfo | null>(null);

  // 引用ボタンから ChatInput に流し込むための draft
  const [draftText, setDraftText] = useState('');

  // 口調スタイル（/iros-ai/settings で localStorage に保存した値を読む）
  const [style, setStyle] = useState<IrosStyle>('friendly');

  // 表示用の state + 内部ロジック用の ref の両立
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const activeConversationIdRef = useRef<string | null>(null);

  // ✅ history 用：クロージャで古い messages を掴まないための ref
  const messagesRef = useRef<IrosMessage[]>([]);
  const latestScreenshotDiagnosisRef = useRef<{
    diagnosis: string;
    diagnosis_seed: unknown;
    at: string;
  } | null>(null);

  const firstOnboardingBootstrapStartedRef = useRef(false);

  // Conversation initialization gate:
  // Prevent sendMessage/bootstrap from creating a new conversation before URL cid is restored.
  const initializedRef = useRef(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const custom = event as CustomEvent<{
        diagnosis?: string;
        diagnosis_seed?: unknown;
        image_data_url?: string;
        local_image_id?: string | null;
      }>;

      const diagnosis = String(custom.detail?.diagnosis || '').trim();
      const imageDataUrl = String(custom.detail?.image_data_url || '').trim();
      const localImageId = String(custom.detail?.local_image_id || '').trim();
      if (!diagnosis) return;

      const now = new Date().toISOString();

      latestScreenshotDiagnosisRef.current = {
        diagnosis,
        diagnosis_seed: custom.detail?.diagnosis_seed ?? null,
        at: now,
      };
      console.info('[IROS_SCREENSHOT_DIAGNOSIS_COMPLETE]', {
        hasDiagnosis: Boolean(diagnosis),
        diagnosisLen: diagnosis.length,
        hasImageDataUrl: Boolean(imageDataUrl),
        localImageId: localImageId || null,
      });

      const diagnosisText = `【スクショ診断結果】` + "\n" + diagnosis;

      const imageMsg: IrosMessage | null =
        imageDataUrl || localImageId
          ? ({
              id: `screenshot-image-${Date.now()}`,
              role: 'user',
              text: '📎 スクショ画像',
              content: '📎 スクショ画像',
              created_at: now,
              ts: Date.now(),
              meta: {
                kind: 'screenshot_image_preview',
                image_data_url: imageDataUrl || undefined,
                localImageId: localImageId || null,
                local_image_id: localImageId || null,
                localOnly: true,
              },
            } as IrosMessage)
          : null;

      const diagnosisMsg: IrosMessage = {
        id: `screenshot-diagnosis-${Date.now()}`,
        role: 'assistant',
        text: diagnosisText,
        content: diagnosisText,
        created_at: now,
        ts: Date.now() + 1,
        meta: {
          kind: 'screenshot_diagnosis',
          diagnosis_seed: custom.detail?.diagnosis_seed ?? null,
        },
      } as IrosMessage;

      setMessages((prev) => {
        const next = imageMsg ? [imageMsg, diagnosisMsg] : [diagnosisMsg];
        return [...(prev || []), ...next];
      });
};

    window.addEventListener('iros:screenshot-diagnosis-complete', handler as EventListener);
    return () => {
      window.removeEventListener('iros:screenshot-diagnosis-complete', handler as EventListener);
    };
  }, []);

  

  /* ========== Style 初期ロード ========== */

  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      const v = window.localStorage.getItem(STYLE_STORAGE_KEY);
      if (
        v === 'friendly' ||
        v === 'biz-soft' ||
        v === 'biz-formal' ||
        v === 'plain'
      ) {
        setStyle(v);
      }
    } catch {
      // localStorage が使えない環境ではデフォルト(friendly)のまま
    }
  }, []);

  /* ========== Conversations ========== */

  const reloadConversations = useCallback(async () => {
    const list = await irosClient.listConversations();
    setConversations(list);
  }, []);
  const startConversation = useCallback(async () => {
    const r = await irosClient.createConversation();

    // ★ 新規会話なので、前のメッセージ/参照を即時クリアしておく
    messagesRef.current = [];
    latestScreenshotDiagnosisRef.current = null;
    setMessages([]);

    // 新しい会話をアクティブに
    activeConversationIdRef.current = r.conversationId;
    setActiveConversationId(r.conversationId);
    replaceUrlCid(r.conversationId);

    await reloadConversations();
    return r.conversationId;
  }, [reloadConversations]);

  const renameConversation = useCallback(
    async (cid: string, title: string) => {
      await irosClient.renameConversation(cid, title);
      await reloadConversations();
    },
    [reloadConversations],
  );

  const deleteConversation = useCallback(
    async (cid: string) => {
      await irosClient.deleteConversation(cid);
      if (activeConversationIdRef.current === cid) {
        activeConversationIdRef.current = null;
        messagesRef.current = [];
        latestScreenshotDiagnosisRef.current = null;
        setActiveConversationId(null);
        setMessages([]);
      }
      await reloadConversations();
    },
    [reloadConversations],
  );

  /* ========== Messages ========== */

  const fetchMessages = useCallback(async (cid: string) => {
    // 直前の会話IDを保持しておく（会話が変わったかどうか判定するため）
    const prevCid = activeConversationIdRef.current;

    // 会話切り替え時にアクティブ ID を更新
    activeConversationIdRef.current = cid;
    setActiveConversationId(cid);

    let rowsRaw: any;
    try {
      rowsRaw = await irosClient.fetchMessages(cid);
    } catch (e) {
      // ✅ 取得失敗時に messages を空にしない（リロードで消える問題の止血）
      devwarn('[IROS][client] fetchMessages failed (keep prev messages)', {
        cid,
        prevCid,
        error: String((e as any)?.message ?? e),
      });

      // 会話切り替え直後に落ちても「空表示」にしない
      setMessages((prev) => prev || []);
      return;
    }

    const rowsBase = normalizeMessages(rowsRaw);

    let screenshotLogs: any[] = [];
    try {
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : null;

      if (idToken) {
        const res = await fetch(
          `/api/mu/screenshot-diagnosis?conversation_id=${encodeURIComponent(cid)}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${idToken}`,
            },
          },
        );

        const json = await res.json().catch(() => null);
        if (res.ok && json?.ok && Array.isArray(json.items)) {
          console.info('[IROS_SCREENSHOT_DIAGNOSIS_RESTORE]', {
            cid,
            count: json.items.length,
          });

          screenshotLogs = json.items;
        }
      }
    } catch (e) {
      devwarn('[IROS][client] screenshot diagnosis restore failed', {
        cid,
        error: String((e as any)?.message ?? e),
      });
    }

    const screenshotMsgs: IrosMessage[] = (screenshotLogs || []).flatMap((item: any) => {
      const rawId = String(item?.id || item?.diagnosis_log_id || item?.created_at || '').trim();
      const id = rawId || crypto.randomUUID();
      const diagnosis = String(item?.diagnosis_text || '').trim();

      if (!diagnosis) return [];

      const createdAt = String(item?.created_at || new Date().toISOString());
      const ts = Date.parse(createdAt) || Date.now();
      const localImageId = rawId;

      const diagnosisText = `【スクショ診断結果】` + "\n" + diagnosis;

      return [
        {
          id: `screenshot-image-${id}`,
          role: 'user',
          text: '📎 スクショ画像',
          content: '📎 スクショ画像',
          created_at: createdAt,
          ts,
          meta: {
            kind: 'screenshot_image_preview',
            localImageId: localImageId || null,
            local_image_id: localImageId || null,
            localOnly: true,
            fallbackText:
              'この画像は、この端末のブラウザ内にのみ保存されています。診断結果は下に保存されています。',
          },
        } as IrosMessage,
        {
          id: `screenshot-diagnosis-${id}`,
          role: 'assistant',
          text: diagnosisText,
          content: diagnosisText,
          created_at: createdAt,
          ts: ts + 1,
          meta: {
            kind: 'screenshot_diagnosis',
            diagnosis_seed: item?.diagnosis_seed_json ?? null,
          },
        } as IrosMessage,
      ];
    });
    const latestScreenshot = [...screenshotLogs]
      .reverse()
      .find((item: any) => String(item?.diagnosis_text || '').trim());

    if (latestScreenshot) {
      latestScreenshotDiagnosisRef.current = {
        diagnosis: String(latestScreenshot.diagnosis_text || '').trim(),
        diagnosis_seed: latestScreenshot.diagnosis_seed_json ?? null,
        at: latestScreenshot.created_at || new Date().toISOString(),
      };
    }

    const rows = (screenshotMsgs.length ? [...rowsBase, ...screenshotMsgs] : rowsBase)
      .slice()
      .sort((a: any, b: any) => {
        const at = Number(a?.ts ?? Date.parse(String(a?.created_at ?? '')) ?? 0);
        const bt = Number(b?.ts ?? Date.parse(String(b?.created_at ?? '')) ?? 0);
        return at - bt;
      });

    setMessages((prev) => {
      // 会話が変わっていたら、過去の Seed は引き継がずにサーバー結果だけにする
      if (prevCid !== cid) {
        return rows;
      }

      // フロント専用の Future-Seed メッセージだけを拾う
      const seedMsgs = (prev || []).filter(
        (m) =>
          m &&
          m.role === 'assistant' &&
          (m as any).meta &&
          (m as any).meta.tLayerModeActive === true,
      );

      if (!seedMsgs.length) {
        return rows;
      }

      // rows 側に既にある id は重ねない（React key 重複防止）
      const rowIdSet = new Set((rows || []).map((m) => String((m as any)?.id ?? '')));
      const seedOnly = seedMsgs.filter((m) => {
        const id = String((m as any)?.id ?? '');
        return id && !rowIdSet.has(id);
      });

      return seedOnly.length ? [...rows, ...seedOnly] : rows;
    });
  }, []);
// ✅ IrosChatContext.tsx（IrosChatProvider 内）
// fetchMessages の下あたりに追加（同一ファイル内ならどこでもOK）

function normalizeForSend(raw: string): { text: string; blockedReason: string | null } {
  const s = String(raw ?? '');

  // NB: ZWSP / BOM / ㅤ(ハングルフィラー) を除去
  const stripped = s
    .replace(/\u200B/g, '') // ZWSP
    .replace(/\uFEFF/g, '') // BOM
    .replace(/\u3164/g, '') // ㅤ
    .trim();

  if (!stripped) return { text: '', blockedReason: 'empty' };

  // ✅ 「無言なし」方針：
  // 省略記号だけ / ドットだけ でも “送信は許可” する。
  // （空扱いにするとサーバ側の SILENCE/FORWARD 連鎖や UI 側のブロックが起きやすい）
  // どうしても誤送信が気になるなら、UIで警告表示に留める（blockedにしない）。

  return { text: stripped, blockedReason: null };
}

const sendMessage = useCallback(
  async (text: string, mode: string = 'auto'): Promise<SendResult> => {
    if (!initializedRef.current) {
      devwarn('[UI/sendMessage] blocked: conversation not initialized');
      return null;
    }

    let cid = activeConversationIdRef.current;

    // 新規ユーザーなどで会話が無い場合は、ここで作成する
    if (!cid) {
      devlog('[UI/sendMessage] no active conversation → startConversation');
      cid = await startConversation();
      if (!cid) {
        devwarn('[UI/sendMessage] startConversation failed');
        return null;
      }
    }

    devlog('[UI/sendMessage] outbound(raw)', {
      cid,
      mode,
      textLen: text?.length ?? 0,
      head: String(text ?? '').slice(0, 120),
    });

    const norm = normalizeForSend(text);

    if (norm.blockedReason) {
      devwarn('[UI/sendMessage] blocked', {
        cid,
        mode,
        reason: norm.blockedReason,
        rawHead: String(text ?? '').slice(0, 120),
      });
      return { assistant: '', meta: { blocked: true, reason: norm.blockedReason } };
    }

    devlog('[UI/sendMessage] outbound(norm)', {
      cid,
      mode,
      textLen: norm.text.length,
      head: norm.text.slice(0, 120),
    });

    setLoading(true);

    const userMsg: IrosMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: norm.text,
      content: norm.text,
      created_at: new Date().toISOString(),
      ts: Date.now(),
    } as IrosMessage;

    try {
      setMessages((m) => [...m, userMsg]);

      devlog('[UI/sendMessage] BEFORE postMessage', { cid });
      await irosClient.postMessage({
        conversationId: cid,
        text: norm.text,
        role: 'user',
        meta: {},
      });
      devlog('[UI/sendMessage] AFTER postMessage', { cid });

      const latestScreenshotDiagnosis = latestScreenshotDiagnosisRef.current;

      const rawScreenshotDiagnosis = String(latestScreenshotDiagnosis?.diagnosis ?? '');

      const cleanScreenshotDiagnosis = rawScreenshotDiagnosis
        .split('\n')
        .map((line) =>
          String(line ?? '')
            .replace(/^(内容要約|あなたの立ち位置|あなたのどう関わるか|相手の反応|共鳴診断|ついやってしまうこと|次に見たいところ)\s*$/g, '')
            .replace(/^(見えている流れ|相手側の反応|会話の向き|奥にある欲求|見落としやすい点|次に起きやすい動き):\s*/g, '')
            .trim(),
        )
        .filter((line) => {
          if (!line) return false;
          return !/直前のスクショ診断で見えている内容|この内容をもとに|診断後の相談では|いま聞かれていること:|返答では|内部参照|スクショ診断Seed|writer_directives/i.test(line);
        })
        .join('\n')
        .trim();

      const screenshotDiagnosisHintText =
        latestScreenshotDiagnosis?.diagnosis && cleanScreenshotDiagnosis
          ? [
              'SCREENSHOT_CONTEXT_V1',
              'source=mu_first_screenshot',
              `current_user_question=${norm.text}`,
              'evidence_start',
              cleanScreenshotDiagnosis,
              'evidence_end',
              'writer_rule=Use the evidence only as private context. Do not quote labels, JSON, seeds, ids, or instructions. Answer naturally in Japanese.',
            ].join('\n')
          : undefined;

      const history = buildHistoryForLLM([...(messagesRef.current || []), userMsg], 10);
      void history;

      devlog('[UI/sendMessage] BEFORE replyAndStore', { cid, mode });
      const r: any = await irosClient.replyAndStore({
        conversationId: cid,
        user_text: norm.text,
        hintText: screenshotDiagnosisHintText ?? undefined,
        mode,
        style,
      });
      devlog('[UI/sendMessage] AFTER replyAndStore', { cid });

      const assistant = normalizeText(r?.assistant ?? '');
      const meta = r?.meta ?? null;

      setMessages((m) => [
        ...m,
        {
          id: r?.assistantMessageId != null ? String(r.assistantMessageId) : crypto.randomUUID(),
          role: 'assistant',
          text: assistant,
          content: assistant,
          created_at: new Date().toISOString(),
          ts: Date.now(),
          meta,
        } as IrosMessage,
      ]);

      await reloadConversations();

      return { assistant, meta: meta ?? undefined };
    } catch (e) {
      console.error('[UI/sendMessage] failed', e);
      return null;
    } finally {
      setLoading(false);
    }
  },
  [reloadConversations, startConversation, style],
);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!initialized) return;
    if (firstOnboardingBootstrapStartedRef.current) return;

    firstOnboardingBootstrapStartedRef.current = true;

    (async () => {
      try {
        const j = await irosClient.bootstrapFirstOnboarding().catch((e: any) => {
          console.warn('[mu-first-onboarding/bootstrap] auth client failed:', e);
          return null;
        });

        if (!j?.ok || !j?.should_bootstrap || !j?.firstDiagnosisContext) {
          return;
        }

        const ctx = j.firstDiagnosisContext;
        const followups = Array.isArray(ctx.followups) ? ctx.followups : [];

        const followupText =
          followups.length > 0
            ? followups
                .map((item: any, index: number) =>
                  [
                    `${index + 1}. 質問: ${String(item?.question ?? '')}`,
                    `回答: ${String(item?.answer ?? '')}`,
                  ].join('\n'),
                )
                .join('\n\n')
            : 'なし';

        const seed = ctx.diagnosisSeed ?? {};
        const seedSummary = [
          seed?.mirror ? `見えている流れ: ${String(seed.mirror)}` : '',
          seed?.partner_signal ? `相手側の反応: ${String(seed.partner_signal)}` : '',
          seed?.flow_direction ? `会話の向き: ${String(seed.flow_direction)}` : '',
          seed?.hidden_need ? `奥にある欲求: ${String(seed.hidden_need)}` : '',
          seed?.blind_spot ? `見落としやすい点: ${String(seed.blind_spot)}` : '',
          seed?.likely_next_move ? `次に起きやすい動き: ${String(seed.likely_next_move)}` : '',
        ].filter(Boolean).join('\n');

        latestScreenshotDiagnosisRef.current = {
          diagnosis: [
            '直前のスクショ診断で見えている内容です。',
            '',
            String(ctx.diagnosisText ?? ''),
            '',
            seedSummary,
            '',
            followupText !== 'なし' ? `診断後の相談では、次の内容も見ています。\n${followupText}` : '',
            '',
            'この内容をもとに、根拠だけを自然な会話として答えます。',
          ].filter(Boolean).join('\n'),
          diagnosis_seed: ctx.diagnosisSeed ?? null,
          at: new Date().toISOString(),
        };

        const bootstrapUserText = String(
          j.message || 'このスクショ診断の続きを、もう少し解説してください。',
        );

        await sendMessage(bootstrapUserText);

        // 自動送信直後の初期ロード競合で user 吹き出しが消えた場合だけ、表示を補正する
        setMessages((prev) => {
          const exists = prev.some(
            (m: any) =>
              m?.role === 'user' &&
              String(m?.text ?? m?.content ?? '') === bootstrapUserText,
          );

          if (exists) return prev;

          const userMsg: IrosMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            text: bootstrapUserText,
            content: bootstrapUserText,
            created_at: new Date().toISOString(),
            ts: Date.now(),
          } as IrosMessage;

          let lastAssistantIndex = -1;
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            if ((prev[i] as any)?.role === 'assistant') {
              lastAssistantIndex = i;
              break;
            }
          }

          if (lastAssistantIndex >= 0) {
            return [
              ...prev.slice(0, lastAssistantIndex),
              userMsg,
              ...prev.slice(lastAssistantIndex),
            ];
          }

          return [...prev, userMsg];
        });
      } catch (e) {
        console.warn('[mu-first-onboarding/bootstrap] client failed:', e);
      }
    })();
  }, [initialized, sendMessage]);

  /* ========== NextStep（ギア選択） ========== */

  const sendNextStepChoice = useCallback(
    async (opt: {
      key: string;
      label: string;
      gear?: string | null;
    }): Promise<SendResult> => {
      const cid = activeConversationIdRef.current;
      if (!cid) return null;

      setLoading(true);

      // ✅ 押された選択肢（タグ無し）
      const choiceText = String(opt.label ?? '').trim();

      // ✅ 直前の assistant を探して「引用」に使う（UI表示だけ）
      const lastAssistantText = (() => {
        const arr = messagesRef.current || [];
        for (let i = arr.length - 1; i >= 0; i--) {
          const m: any = arr[i];
          if (!m) continue;
          if (m.role !== 'assistant') continue;

          const t = normalizeText(m.content ?? m.text).trim();
          if (t) return t;
        }
        return '';
      })();

      // ✅ UIに見せる本文：引用 + 選択肢
      // ※ 引用が無いときは選択肢のみ
      const displayText = lastAssistantText
        ? `> ${lastAssistantText.replace(/\n/g, '\n> ')}\n\n${choiceText}`
        : choiceText;

      // ✅ サーバへはタグ付き raw を送る（DB保存は既存どおりstripされる）
      const rawText = `[${opt.key}] ${opt.label}`;

      const userMsg: IrosMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: displayText, // ✅ UI表示は「引用＋選択肢」
        content: displayText, // ✅ UI表示は「引用＋選択肢」
        created_at: new Date().toISOString(),
        ts: Date.now(),
        meta: {
          nextStepChoice: {
            key: opt.key,
            label: opt.label,
            gear: opt.gear ?? null,
          },
          quotedFromAssistant: Boolean(lastAssistantText),
        },
      } as IrosMessage;

      try {
        // ① user メッセージをローカルに即反映（引用つき）
        setMessages((m) => [...m, userMsg]);

        // ② DB 保存は rawText（タグ付き）で送る
        await irosClient.postMessage({
          conversationId: cid,
          text: rawText,
          role: 'user',
          meta: {}, // ✅ traceId を meta.extra に確実に入れるため
        });

        // ✅ LLM に渡す history（引用はUI演出なので、LLMには“選択肢だけ”を積む）
        const llmUserMsg: IrosMessage = {
          ...userMsg,
          text: choiceText,
          content: choiceText,
        } as IrosMessage;

        const history = buildHistoryForLLM(
          [...(messagesRef.current || []), llmUserMsg],
          10,
        );
        void history;

        // ③ reply はタグ無しテキスト + nextStepChoice
        // NOTE: irosApiClient の型定義に extra/nextStepChoice が無い場合があるので、payload を any に落として渡す
// ③ reply はタグ無しテキスト（choiceText）だけ送る
// NOTE: irosApiClient の型定義に extra が無い場合があるので、payload を any に落として渡す
const payload: any = {
  conversationId: cid,
  user_text: choiceText, // ✅ LLMには「選択肢だけ」
  mode: 'auto',          // ✅ nextStep を名乗らない（廃止なら auto に戻す）
  style,
};

        const r: any = await irosClient.replyAndStore(payload);

        const assistant = normalizeText(r?.assistant ?? '');
        const meta = r?.meta ?? null;

        // ④ assistant をローカル state に反映
        setMessages((m) => [
          ...m,
          {
            id: r?.assistantMessageId != null ? String(r.assistantMessageId) : crypto.randomUUID(),
            role: 'assistant',
            text: assistant,
            content: assistant,
            created_at: new Date().toISOString(),
            ts: Date.now(),
            meta,
          } as IrosMessage,
        ]);

        await reloadConversations();
        return { assistant, meta: meta ?? undefined };
      } catch (e) {
        console.error('[IROS] sendNextStepChoice failed', e);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [reloadConversations, style],
  );

  /* ========== Future-Seed（T層デモ） ========== */

  const sendFutureSeed = useCallback(async (): Promise<SendResult> => {
    // 優先順：
    // 1) ref に入っている activeConversationId
    // 2) state に入っている activeConversationId
    // 3) conversations の先頭
    let cid = activeConversationIdRef.current;

    if (!cid) {
      if (activeConversationId) {
        cid = activeConversationId;
      } else if (conversations && conversations.length > 0) {
        cid = conversations[0].id;
      }

      if (cid) {
        devlog('[IROS] Future-Seed: activeConversationId を補完しました', cid);
        activeConversationIdRef.current = cid;
        setActiveConversationId(cid);
      }
    }

    devlog('[IROS] Seed ボタンが押されました（Future-Seed 起動）');

    if (!cid) {
      devwarn('[IROS] No active conversation for future-seed (after fallback)');
      return null;
    }

    setLoading(true);
    try {
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : null;

      if (!idToken) {
        devwarn('[IROS] Future-Seed: no idToken (not logged in?)');
        return null;
      }

      const body = { conversationId: cid };
      devlog('[IROS] Future-Seed request body', body);

      const res = await fetch('/api/agent/iros/future-seed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '(no body)');
        console.error('[IROS] future-seed API error', res.status, detail);
        return null;
      }

      const data: any = await res.json();

      const assistant = normalizeText(
        data?.reply ?? data?.assistant ?? data?.message ?? '',
      );
      const meta = data?.meta ?? data?.result?.meta ?? null;

      if (!assistant) {
        devwarn('[IROS] Future-Seed result null');
        return null;
      }

      // Seed メッセージをローカル state に追加（DB保存はしない）
      setMessages((m) => {
        const next = [
          ...m,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: assistant,
            content: assistant,
            created_at: new Date().toISOString(),
            ts: Date.now(),
            meta,
          } as IrosMessage,
        ];

        devlog('[IROS] Seed setMessages', {
          before: m.length,
          after: next.length,
          last: {
            id: next[next.length - 1]?.id,
            role: next[next.length - 1]?.role,
            meta: (next[next.length - 1] as any)?.meta,
          },
        });

        return next;
      });

      return { assistant, meta: meta ?? undefined };
    } catch (e) {
      console.error('[IROS] future-seed failed', e);
      return null;
    } finally {
      setLoading(false);
    }
  }, [activeConversationId, conversations]);

  /* ========== User Info ========== */

  const reloadUserInfo = useCallback(async () => {
    const u = await irosClient.getUserInfo();
    setUserInfo(u);
  }, []);

  /* ========== 新しいチャット / 会話選択 API ========== */
  const newConversation = useCallback(async () => {
    const cid = await startConversation();
    return cid;
  }, [startConversation]);

  const selectConversation = useCallback(
    async (cid: string) => {
      await fetchMessages(cid);
    },
    [fetchMessages],
  );
  /* ========== 初期ロード ========== */

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await reloadUserInfo();

        const params =
          typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();

        const cidFromUrl = params.get('cid');

        if (cidFromUrl === 'new') {
          const cid = await startConversation();
          if (!cancelled) {
            activeConversationIdRef.current = cid;
            setActiveConversationId(cid);
          }
        } else if (isUuidLike(cidFromUrl)) {
          activeConversationIdRef.current = cidFromUrl;
          setActiveConversationId(cidFromUrl);
          await fetchMessages(cidFromUrl);
          await reloadConversations();
        } else {
          await reloadConversations();
        }
      } catch (e) {
        devwarn('[IROS/CONVERSATION_INIT] failed', {
          error: String((e as any)?.message ?? e),
        });
        await reloadConversations().catch(() => undefined);
      } finally {
        if (!cancelled) {
          initializedRef.current = true;
          setInitialized(true);
          devlog('[IROS/CONVERSATION_INIT]', {
            activeConversationId: activeConversationIdRef.current,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchMessages, reloadConversations, reloadUserInfo, startConversation]);

  const lastAssistantMsg =
    [...messages]
      .reverse()
      .find((m) => (m as any)?.role === 'assistant') ?? null;

  const lastMeta = lastAssistantMsg
    ? {
        ...(((lastAssistantMsg as any)?.meta && typeof (lastAssistantMsg as any).meta === 'object')
          ? (lastAssistantMsg as any).meta
          : {}),

        qCode:
          (lastAssistantMsg as any)?.meta?.qCode ??
          (lastAssistantMsg as any)?.meta?.q_code ??
          (lastAssistantMsg as any)?.meta?.q ??
          (lastAssistantMsg as any)?.qCode ??
          (lastAssistantMsg as any)?.q_code ??
          (lastAssistantMsg as any)?.q ??
          null,

        depth:
          (lastAssistantMsg as any)?.meta?.personDepthPattern ??
          (lastAssistantMsg as any)?.meta?.person_depth_pattern ??
          (lastAssistantMsg as any)?.meta?.qCounts?.person_depth_pattern ??
          (lastAssistantMsg as any)?.meta?.q_counts?.person_depth_pattern ??
          (lastAssistantMsg as any)?.personDepthPattern ??
          (lastAssistantMsg as any)?.person_depth_pattern ??
          (lastAssistantMsg as any)?.depth ??
          (lastAssistantMsg as any)?.depthStage ??
          (lastAssistantMsg as any)?.depth_stage ??
          (lastAssistantMsg as any)?.meta?.depth ??
          (lastAssistantMsg as any)?.meta?.depthStage ??
          (lastAssistantMsg as any)?.meta?.depth_stage ??
          null,

        depthStage:
          (lastAssistantMsg as any)?.depthStage ??
          (lastAssistantMsg as any)?.depth_stage ??
          (lastAssistantMsg as any)?.depth ??
          (lastAssistantMsg as any)?.meta?.depthStage ??
          (lastAssistantMsg as any)?.meta?.depth_stage ??
          (lastAssistantMsg as any)?.meta?.depth ??
          null,

        personDepthPattern:
          (lastAssistantMsg as any)?.meta?.personDepthPattern ??
          (lastAssistantMsg as any)?.meta?.person_depth_pattern ??
          (lastAssistantMsg as any)?.meta?.qCounts?.person_depth_pattern ??
          (lastAssistantMsg as any)?.meta?.q_counts?.person_depth_pattern ??
          (lastAssistantMsg as any)?.personDepthPattern ??
          (lastAssistantMsg as any)?.person_depth_pattern ??
          null,
      }
    : null;

  return (
    <IrosChatContext.Provider
    value={{
      loading,
      messages,
      conversations,
      userInfo,

      draftText,
      setDraftText,

      activeConversationId,
      getActiveConversationId: () => activeConversationIdRef.current,
      style,

        currentMeta: lastMeta,
        lastMeta,
        meta: lastMeta,

        fetchMessages,
        sendMessage,
        sendNextStepChoice,
        sendFutureSeed,

        startConversation,
        renameConversation,
        deleteConversation,
        reloadConversations,
        reloadUserInfo,

        newConversation,
        selectConversation,
      }}
    >
      {children}
    </IrosChatContext.Provider>
  );
};

