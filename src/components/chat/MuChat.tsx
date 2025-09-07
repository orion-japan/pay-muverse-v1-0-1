// src/components/chat/MuChat.tsx
// Mu 専用チャット薄層（UI文言のみ差し替え・ロジック最小）
// - props.messages を描画し、送信時に onSend を呼ぶ
// - A/B/その他の簡易ボタンと画像ブリッジの定型句を提供

"use client";

import React, { useMemo, useRef, useState, useEffect } from "react";
import { MU_AGENT, MU_UI_TEXT, MU_BRIDGE_TEXT, MU_STATES } from "@/lib/mu/config";
import { buildImageBridgeText } from "@/lib/qcode/bridgeImage";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  at?: string;
  // サーバから付与されうる緩いメタ（型拡張は any で読む）
  // agent?: "Mu" | "Iros" | "mu" | "iros";
  // conversation_id?: string; master_id?: string; convId?: string;
};

export type MuChatProps = {
  conversationId?: string; // ★ 与えられたら、その会話にスコープ
  messages: ChatMessage[];
  isLoading?: boolean;
  onSend: (input: { text: string; meta?: Record<string, unknown> }) => Promise<void> | void;
  onSuggestImage?: () => void; // 画像ブリッジ提示を外部でハンドルする場合
  placeholder?: string;
  showABHelper?: boolean;
  stateLabel?: keyof typeof MU_STATES; // "INTENT_CHECKING" | "AGREED" | "DONE"
};

export default function MuChat(props: MuChatProps) {
  const {
    conversationId,
    messages,
    isLoading,
    onSend,
    onSuggestImage,
    placeholder = "入力してください…（Mu：質問は1つまで）",
    showABHelper = true,
    stateLabel = "INTENT_CHECKING",
  } = props;

  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const headerTitle = useMemo(() => `${MU_UI_TEXT.AGENT_DISPLAY_NAME}`, []);
  const stateText = useMemo(() => MU_STATES[stateLabel] ?? MU_STATES.INTENT_CHECKING, [stateLabel]);

  // ==== Mu 以外のメッセージ混入を除外 + 会話IDスコープ + 粘着表示 ====
  const filtered = useMemo(() => {
    const convKeys = ["conversation_id", "master_id", "convId", "conversationId"];

    const sameConv = (m: any) => {
      if (!conversationId) return true; // 会話ID指定がなければ許可
      for (const k of convKeys) {
        const v = m?.[k];
        if (typeof v === "string" && v.trim() && v.trim() === conversationId) return true;
      }
      return false;
    };

    const isMuAgent = (m: any) => {
      const a = (m?.agent ?? "").toString().toLowerCase();
      // agent が無い場合は後方互換で許可、ある場合は 'mu' のみ許可
      return !a || a === "mu";
    };

    const list = (messages ?? []).filter((m: any) => {
      // 会話IDが指定されている場合はスコープ外を除外
      if (!sameConv(m)) return false;

      if (m.role === "assistant" || m.role === "system") {
        // Mu 専用：Mu 以外(Iros等)は表示しない（大小文字差は無視）
        return isMuAgent(m);
      }
      // user は常に許可
      return true;
    });

    // id 重複の排除
    const map = new Map<string, ChatMessage>();
    for (const m of list) map.set(m.id, m);
    return Array.from(map.values());
  }, [messages, conversationId]);

  // 一時的に空が来ても直前の非空を保持（“一瞬表示→消える”を防ぐ）
  const lastNonEmptyRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    if (filtered.length > 0) lastNonEmptyRef.current = filtered;
  }, [filtered]);

  const displayMessages = filtered.length > 0 ? filtered : lastNonEmptyRef.current;
  // ==== 追加ここまで ====

  const handleSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await onSend({ text });
    inputRef.current?.focus();
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const sendQuick = (t: string) => onSend({ text: t });

  const imageSuggestText = useMemo(() => buildImageBridgeText({ phase: "suggest" }), []);

  return (
    <div style={styles.root} data-agent={MU_AGENT.ID}>
      <div style={styles.header}>
        <div style={styles.headerTitle}>{headerTitle}</div>
        <div style={styles.headerSub}>{MU_UI_TEXT.AGENT_DESC}</div>
        <div style={styles.statePill}>{stateText}</div>
      </div>

      <div style={styles.body} aria-live="polite">
        {displayMessages.map((m) => (
          <MessageBubble key={m.id} role={m.role} content={m.content} />
        ))}

        {showABHelper && (
          <div style={styles.helperRow}>
            <span style={styles.helperHint}>{MU_UI_TEXT.ASK_INTENT_AB}</span>
            <div style={styles.helperBtns}>
              <button style={styles.helperBtn} onClick={() => sendQuick("A でお願いします。")}>
                Aで進める
              </button>
              <button style={styles.helperBtn} onClick={() => sendQuick("B でお願いします。")}>
                Bで進める
              </button>
              <button style={styles.helperBtn} onClick={() => sendQuick("その他（自由入力）で。")}>
                その他
              </button>
            </div>
          </div>
        )}

        <div style={styles.helperRow}>
          <span style={styles.helperHint}>画像化</span>
          <div style={styles.helperBtns}>
            <button
              style={styles.helperBtnOutline}
              onClick={() => {
                if (onSuggestImage) onSuggestImage();
                else sendQuick(imageSuggestText);
              }}
              title="画像ブリッジの定型句を送信"
            >
              {MU_BRIDGE_TEXT.SUGGEST_IMAGE()}
            </button>
          </div>
        </div>
      </div>

      <div style={styles.footer}>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={2}
          style={styles.textarea}
          disabled={isLoading}
        />
        <div style={styles.actions}>
          <button style={styles.sendBtn} onClick={handleSend} disabled={isLoading || !draft.trim()}>
            送信
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ role, content }: { role: "user" | "assistant" | "system"; content: string }) {
  const isUser = role === "user";
  const isSystem = role === "system";
  return (
    <div
      style={{
        ...styles.bubble,
        ...(isUser ? styles.bubbleUser : {}),
        ...(isSystem ? styles.bubbleSystem : {}),
      }}
    >
      <div style={styles.bubbleRole}>{role}</div>
      <div style={styles.bubbleText}>{content}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    maxHeight: "100vh",
    background: "var(--sof-bg, #0b1437)",
    color: "#e8ecff",
  },
  header: {
    padding: "12px 16px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  headerTitle: { fontSize: 16, fontWeight: 700 },
  headerSub: { fontSize: 12, opacity: 0.8, marginTop: 4 },
  statePill: {
    marginTop: 8,
    display: "inline-block",
    fontSize: 11,
    padding: "4px 8px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    opacity: 0.9,
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  footer: {
    borderTop: "1px solid rgba(255,255,255,0.08)",
    padding: 12,
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 8,
  },
  textarea: {
    width: "100%",
    resize: "vertical",
    minHeight: 48,
    maxHeight: 160,
    padding: 10,
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.04)",
    color: "#e8ecff",
    outline: "none",
  },
  actions: { display: "flex", alignItems: "center", gap: 8 },
  sendBtn: {
    padding: "10px 16px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.06))",
    color: "#fff",
    cursor: "pointer",
  },
  bubble: {
    maxWidth: "88%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.04)",
  },
  bubbleUser: {
    alignSelf: "flex-end",
    background: "rgba(93, 139, 255, 0.12)",
    borderColor: "rgba(93, 139, 255, 0.28)",
  },
  bubbleSystem: {
    alignSelf: "center",
    background: "rgba(255,255,255,0.02)",
    borderStyle: "dashed",
  },
  bubbleRole: { fontSize: 10, opacity: 0.6, marginBottom: 4 },
  bubbleText: { whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14 },
  helperRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    marginTop: 6,
  },
  helperHint: { fontSize: 12, opacity: 0.75 },
  helperBtns: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  helperBtn: {
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.22)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    cursor: "pointer",
  },
  helperBtnOutline: {
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.22)",
    background: "transparent",
    color: "#fff",
    cursor: "pointer",
  },
};
