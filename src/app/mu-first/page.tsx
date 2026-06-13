"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { authedFetch, useAuth } from "@/context/AuthContext";

type AnalyzeResponse =
  | {
      ok: true;
      result: string;
      model: string;
      screenshotCreditRemaining?: number;
    }
  | {
      ok: false;
      error: string;
    };

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_IMAGE_SIZE_MB = 5;

export default function MuFirstPage() {
  const { user, loading } = useAuth();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [screenshotCreditRemaining, setScreenshotCreditRemaining] =
    useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const canSubmit = useMemo(() => {
    return Boolean(file && user && !loading && !submitting);
  }, [file, user, loading, submitting]);

  function clearCurrentImage() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl("");
    setResult("");
    setError("");
    setScreenshotCreditRemaining(null);
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null;

    setResult("");
    setError("");
    setScreenshotCreditRemaining(null);

    if (!nextFile) {
      clearCurrentImage();
      return;
    }

    if (!ALLOWED_MIME_TYPES.includes(nextFile.type)) {
      clearCurrentImage();
      setError("画像は PNG、JPEG、WebP のみ対応しています。");
      return;
    }

    if (nextFile.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
      clearCurrentImage();
      setError("画像サイズは 5MB 以内にしてください。");
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);

    setFile(nextFile);
    setPreviewUrl(URL.createObjectURL(nextFile));
  }

  async function handleAnalyze() {
    if (!file || !canSubmit) return;

    setSubmitting(true);
    setError("");
    setResult("");
    setScreenshotCreditRemaining(null);

    try {
      const formData = new FormData();
      formData.append("image", file);

      const res = await authedFetch("/api/mu-first/analyze", {
        method: "POST",
        body: formData,
      });

      const data = (await res.json().catch(() => ({}))) as AnalyzeResponse;

      if (!res.ok || !data.ok) {
        setError(data.ok === false ? data.error : "診断に失敗しました。");
        return;
      }

      setResult(data.result);
      setScreenshotCreditRemaining(
        typeof data.screenshotCreditRemaining === "number"
          ? data.screenshotCreditRemaining
          : null,
      );
    } catch (e: any) {
      setError(e?.message || "診断に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <main style={styles.center}>確認中です…</main>;
  }

  if (!user) {
    return (
      <main style={styles.shell}>
        <section style={styles.card}>
          <p style={styles.kicker}>Muverse</p>
          <h1 style={styles.title}>ログインが必要です</h1>
          <p style={styles.text}>
            初回スクショ診断を使うには、登録またはログインを完了してください。
          </p>
          <Link href="/" style={styles.primaryLink}>
            登録ページへ戻る
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main style={styles.shell}>
      <section style={styles.stack}>
        <div style={styles.card}>
          <p style={styles.kicker}>初回スクショ診断</p>
          <h1 style={styles.title}>LINEやDMのスクショを1枚アップロードしてください。</h1>
          <p style={styles.text}>
            この診断では、相手の本心や未来を断定しません。見えている会話の範囲から、
            温度差、返信の間、あなたが反応している言葉を見ます。
          </p>
          <p style={styles.notice}>
            名前・電話番号・住所などは隠して送ってください。緊急性のある相談、暴力、
            自傷に関する内容は扱えません。
          </p>
        </div>

        <div style={styles.card}>
          <label style={styles.uploadBox}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFileChange}
              style={{ display: "none" }}
            />
            <span style={styles.uploadTitle}>スクリーンショットを選ぶ</span>
            <span style={styles.uploadText}>PNG / JPEG / WebP、5MB以内、1枚のみ</span>
          </label>

          {file ? (
            <p style={styles.fileName}>選択中：{file.name}</p>
          ) : null}

          {previewUrl ? (
            <div style={styles.previewFrame}>
              <img
                src={previewUrl}
                alt="選択したスクリーンショット"
                style={styles.previewImage}
              />
            </div>
          ) : null}

          {previewUrl ? (
            <button type="button" onClick={clearCurrentImage} style={styles.secondaryButton}>
              画像を選び直す
            </button>
          ) : null}

          <button
            type="button"
            onClick={handleAnalyze}
            disabled={!canSubmit}
            style={{
              ...styles.primaryButton,
              background: canSubmit ? "#2d241f" : "#d9d5d2",
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {submitting ? "Muがスクショを読んでいます…" : "診断する"}
          </button>

          {submitting ? (
            <p style={styles.smallText}>10〜20秒ほどかかることがあります。</p>
          ) : null}

          {error ? <p style={styles.errorText}>{error}</p> : null}
        </div>

        {result ? (
          <div style={styles.card}>
            <p style={styles.kicker}>Muの診断結果</p>
            <p style={styles.resultText}>{result}</p>

            {screenshotCreditRemaining !== null ? (
              <p style={styles.smallText}>
                スクショ診断クレジット残数：{screenshotCreditRemaining}
              </p>
            ) : null}

            <div style={styles.nextBox}>
              <p style={styles.nextTitle}>この続きは、Muにそのまま話しかけられます。</p>
              <p style={styles.text}>
                登録特典の90クレジットで、今の診断についてそのまま相談できます。
              </p>
              <Link href="/mu" style={styles.primaryLink}>
                Muと話してみる
              </Link>
            </div>
          </div>
        ) : null}

        <Link href="/mu-entry" style={styles.backLink}>
          入口に戻る
        </Link>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: "100dvh",
    display: "flex",
    justifyContent: "center",
    padding: "24px 16px",
    background: "#f7f7f8",
  },
  center: {
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
  },
  stack: {
    width: "100%",
    maxWidth: 430,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  card: {
    width: "100%",
    boxSizing: "border-box",
    background: "#fff",
    borderRadius: 24,
    padding: 20,
    boxShadow: "0 16px 40px rgba(0,0,0,0.08)",
    border: "1px solid rgba(0,0,0,0.06)",
  },
  kicker: {
    margin: 0,
    fontSize: 13,
    color: "#8a6a4f",
    fontWeight: 700,
  },
  title: {
    margin: "10px 0 12px",
    fontSize: 24,
    lineHeight: 1.35,
    color: "#222",
  },
  text: {
    margin: "10px 0 0",
    fontSize: 14,
    lineHeight: 1.8,
    color: "#444",
  },
  notice: {
    margin: "14px 0 0",
    padding: 12,
    borderRadius: 14,
    background: "#fff7ed",
    color: "#6d4b31",
    fontSize: 12,
    lineHeight: 1.7,
  },
  uploadBox: {
    display: "block",
    border: "1.5px dashed rgba(45,36,31,0.26)",
    borderRadius: 20,
    padding: 18,
    textAlign: "center",
    cursor: "pointer",
    background: "#fffaf5",
  },
  uploadTitle: {
    display: "block",
    color: "#2d241f",
    fontSize: 15,
    fontWeight: 700,
  },
  uploadText: {
    display: "block",
    marginTop: 8,
    color: "#8b817b",
    fontSize: 12,
    lineHeight: 1.6,
  },
  fileName: {
    margin: "12px 0 0",
    color: "#6d4b31",
    fontSize: 13,
    lineHeight: 1.6,
  },
  previewFrame: {
    marginTop: 14,
    borderRadius: 18,
    overflow: "hidden",
    border: "1px solid rgba(0,0,0,0.08)",
    background: "#eee",
  },
  previewImage: {
    display: "block",
    width: "100%",
    height: "auto",
  },
  primaryButton: {
    width: "100%",
    marginTop: 16,
    border: "none",
    borderRadius: 999,
    padding: "15px 18px",
    color: "#fff",
    fontSize: 16,
    fontWeight: 700,
  },
  secondaryButton: {
    width: "100%",
    marginTop: 12,
    border: "1px solid rgba(45,36,31,0.14)",
    borderRadius: 999,
    padding: "12px 16px",
    background: "#fff",
    color: "#2d241f",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  primaryLink: {
    display: "block",
    marginTop: 18,
    textAlign: "center",
    textDecoration: "none",
    borderRadius: 999,
    padding: "14px 18px",
    background: "#2d241f",
    color: "#fff",
    fontSize: 15,
    fontWeight: 700,
  },
  backLink: {
    textAlign: "center",
    color: "#8b817b",
    fontSize: 13,
    textDecoration: "none",
    padding: "8px 0",
  },
  resultText: {
    margin: "12px 0 0",
    color: "#2d241f",
    fontSize: 15,
    lineHeight: 1.9,
    whiteSpace: "pre-wrap",
  },
  smallText: {
    margin: "10px 0 0",
    color: "#8b817b",
    fontSize: 12,
    lineHeight: 1.6,
    textAlign: "center",
  },
  errorText: {
    margin: "12px 0 0",
    color: "#b3261e",
    fontSize: 13,
    lineHeight: 1.7,
  },
  nextBox: {
    marginTop: 22,
    borderTop: "1px solid rgba(45,36,31,0.1)",
    paddingTop: 18,
  },
  nextTitle: {
    margin: 0,
    color: "#2d241f",
    fontSize: 15,
    fontWeight: 700,
    lineHeight: 1.7,
  },
};
