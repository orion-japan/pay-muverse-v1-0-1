// src/components/chat/MuChat.tsx
// Mu 専用チャット薄層（UI文言のみ差し替え・ロジック最小）
// - props.messages を描画し、送信時に onSend を呼ぶ
// - A/B/その他の簡易ボタンと画像ブリッジの定型句を提供

"use client";

import React, { useMemo, useRef, useState } from "react";
import { MU_AGENT, MU_UI_TEXT, MU_BRIDGE_TEXT, MU_STATES } from "@/lib/mu/config";
import { buildImageBridgeText } from "@/lib/qcode/bridgeImage";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  at?: string;
};

export type MuChatProps = {
  conversationId?: string;
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
        {messages.map((m) => (
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
