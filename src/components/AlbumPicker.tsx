// src/components/AlbumPicker.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type AlbumFile = {
  name: string;
  path: string; // e.g. "669933/image.jpg"
  url: string;  // public or signed url
  size?: number | null;
  updatedAt?: string | null;
};

export default function AlbumPicker({
  open,
  userCode,
  bucket = "album",
  onClose,
  onPick,
  limit = 200,
}: {
  open: boolean;
  userCode: string;
  bucket?: string;
  limit?: number;
  onClose: () => void;
  onPick: (urls: string[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<AlbumFile[]>([]);
  const [sel, setSel] = useState<Record<string, boolean>>({}); // path -> checked

  const selectedUrls = useMemo(
    () => files.filter((f) => sel[f.path]).map((f) => f.url),
    [files, sel]
  );

  useEffect(() => {
    if (!open) return;

    (async () => {
      setLoading(true);
      try {
        // 1) ユーザーフォルダ直下を一覧
        const listRes = await supabase.storage
          .from(bucket)
          .list(`${userCode}`, {
            limit,
            sortBy: { column: "updated_at", order: "desc" },
          });

        if (listRes.error) throw listRes.error;

        const rows = listRes.data || [];
        const resolved: AlbumFile[] = [];

        for (const it of rows) {
          if (!it?.name) continue;

          const path = `${userCode}/${it.name}`;

          // 2) まず public URL を取得（v2は error を返さない設計）
          const { data: pubData } = supabase.storage.from(bucket).getPublicUrl(path);
          let url: string | null = pubData?.publicUrl || null;

          // 3) URLが取れない/非公開なら署名URL（1h）にフォールバック
          if (!url) {
            const signed = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
            if (signed.error || !signed.data?.signedUrl) continue;
            url = signed.data.signedUrl;
          }

          resolved.push({
            name: it.name,
            path,
            url,
            size: (it as any).metadata?.size ?? null,
            updatedAt: (it as any).updated_at ?? null,
          });
        }

        setFiles(resolved);
        setSel({}); // 表示のたびに選択初期化
      } finally {
        setLoading(false);
      }
    })();
  }, [open, userCode, bucket, limit]);

  const toggle = (path: string) => {
    setSel((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  if (!open) return null;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* ヘッダー */}
        <div style={styles.header}>
          <h3 style={{ margin: 0 }}>アルバムから選ぶ</h3>
          <button style={styles.iconBtn} onClick={onClose} title="閉じる">
            ✕
          </button>
        </div>

        {/* 本文 */}
        {loading ? (
          <div style={{ padding: 16 }}>読み込み中…</div>
        ) : files.length === 0 ? (
          <div style={{ padding: 16, color: "#666" }}>画像がありません</div>
        ) : (
          <div style={styles.grid}>
            {files.map((f) => (
              <label key={f.path} style={styles.cell} title={f.name}>
                <input
                  type="checkbox"
                  checked={!!sel[f.path]}
                  onChange={() => toggle(f.path)}
                  style={{ position: "absolute", top: 8, left: 8 }}
                />
                <img
                  src={f.url}
                  alt={f.name}
                  style={styles.thumb}
                  crossOrigin="anonymous"
                />
                <div style={styles.name}>{f.name}</div>
              </label>
            ))}
          </div>
        )}

        {/* フッター操作 */}
        <div style={styles.footer}>
          <button style={styles.secondaryBtn} onClick={onClose}>
            キャンセル
          </button>
          <button
            style={styles.primaryBtn}
            onClick={() => onPick(selectedUrls)}
            disabled={selectedUrls.length === 0}
            title="選択した画像を追加"
          >
            追加（{selectedUrls.length}）
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },
  modal: {
    width: "min(960px, 92vw)",
    maxHeight: "86vh",
    overflow: "auto",
    background: "#fff",
    borderRadius: 12,
    border: "1px solid #e7e7e7",
    boxShadow: "0 12px 40px rgba(0,0,0,0.2)",
    padding: 12,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 10,
  },
  cell: {
    position: "relative",
    display: "block",
    border: "1px solid #eee",
    borderRadius: 10,
    overflow: "hidden",
    background: "#fafafa",
    cursor: "pointer",
  },
  thumb: {
    width: "100%",
    height: 150,
    objectFit: "cover",
    display: "block",
  },
  name: {
    fontSize: 12,
    padding: "6px 8px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    borderTop: "1px solid #eee",
    background: "#fff",
  },
  footer: {
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
    marginTop: 12,
  },
  primaryBtn: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid #6b5bfa",
    background: "linear-gradient(180deg, #8f7dff 0%, #6b5bfa 100%)",
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(122, 101, 255, 0.25)",
  },
  secondaryBtn: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid #ddd",
    background: "#fff",
    color: "#333",
    cursor: "pointer",
  },
  iconBtn: {
    border: "1px solid #ddd",
    background: "#fff",
    padding: "4px 8px",
    borderRadius: 6,
    cursor: "pointer",
  },
};
