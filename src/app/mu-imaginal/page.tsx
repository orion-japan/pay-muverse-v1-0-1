"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { authedFetch, useAuth } from "@/context/AuthContext";

type DiagnosisResponse = {
  ok?: boolean;
  diagnosis?: string;
  diagnosis_seed?: unknown;
  diagnosis_log_id?: string | null;
  error?: string;
  detail?: string;
  credit_consumed?: number;
  model?: string;
};

const FOLLOWUP_QUESTIONS = [
  "思っている未来と願っている未来の意味を教えてください",
  "なぜ同じことが繰り返されますか？",
  "願っている未来を現実にする方法を教えてください",
  "イマジナルとはなんですか？",
  "なんでわかるんですか？",
];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("invalid_file_result"));
    };

    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

export default function MuImaginalPage() {
  const { user, loading } = useAuth();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [imageName, setImageName] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [diagnosisSeed, setDiagnosisSeed] = useState<unknown>(null);
  const [diagnosisLogId, setDiagnosisLogId] = useState<string | null>(null);
  const [selectedQuestion, setSelectedQuestion] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = useMemo(
    () => Boolean(previewUrl && selectedFile && user && !loading && !submitting),
    [previewUrl, selectedFile, user, loading, submitting],
  );

  async function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      setSelectedFile(null);
      setImageName("");
      setPreviewUrl("");
      setDiagnosis("");
      setDiagnosisSeed(null);
      setDiagnosisLogId(null);
      setSelectedQuestion("");
      setError("");
      return;
    }

    setSelectedFile(file);
    setImageName(file.name || "");
    setDiagnosis("");
    setDiagnosisSeed(null);
    setDiagnosisLogId(null);
    setSelectedQuestion("");
    setError("");

    try {
      const dataUrl = await fileToDataUrl(file);
      setPreviewUrl(dataUrl);
    } catch {
      setPreviewUrl(URL.createObjectURL(file));
    }
  }

  async function handleSubmit() {
    if (!canSubmit || !selectedFile) return;

    setSubmitting(true);
    setDiagnosis("");
    setDiagnosisSeed(null);
    setDiagnosisLogId(null);
    setSelectedQuestion("");
    setError("");

    try {
      if (!selectedFile.type.startsWith("image/")) {
        setError("画像ファイルを選択してください。");
        return;
      }

      if (selectedFile.size > 8 * 1024 * 1024) {
        setError("画像サイズが大きすぎます。8MB以内にしてください。");
        return;
      }

      const imageDataUrl = await fileToDataUrl(selectedFile);

      const res = await authedFetch("/api/mu/imaginal-diagnosis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_data_url: imageDataUrl,
          source: "mu_imaginal",
        }),
      });

      const data = (await res.json().catch(() => ({}))) as DiagnosisResponse;

      if (!res.ok || !data.ok) {
        const message =
          data.error === "invalid_image"
            ? "画像を読み取れませんでした。別の画像でお試しください。"
            : data.error === "missing_openai_api_key"
              ? "OpenAI APIキーが未設定です。"
              : data.error === "llm_failed"
                ? "診断生成でエラーが起きました。"
                : data.error === "screenshot_diagnosis_plan_required"
                  ? "この診断はプレミアム以上で利用できます。"
                  : data.error === "no_mu_screenshot_credit"
                    ? "診断に必要なクレジットがありません。"
                    : data.detail || data.error || "診断に失敗しました。";

        setError(message);
        return;
      }

      setDiagnosis(String(data.diagnosis || "").trim());
      setDiagnosisSeed(data.diagnosis_seed ?? null);
      setDiagnosisLogId(data.diagnosis_log_id ?? null);
    } catch (e: any) {
      setError(e?.message || "診断に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={styles.shell}>
      <section style={styles.container}>
        <div style={styles.heroCard}>
          <p style={styles.kicker}>Mu Imaginal Diagnosis</p>
          <h1 style={styles.title}>
            画像を1枚送って、
            <br />
            今のイマジナルを見る
          </h1>
          <p style={styles.lead}>
            LINE、SNS、メモ、書きかけの投稿、予定表、ToDo、Mu BOOKで気になったページなど、
            いま心が止まっている画面を1枚選んでください。
          </p>
          <p style={styles.leadSmall}>
            Muは画像の説明ではなく、そこから立ち上がっている「思い続けている未来」と
            「願っている未来」の差分を見ます。
          </p>
        </div>

        {!loading && !user ? (
          <div style={styles.notice}>
            イマジナル診断を使うにはログインが必要です。
            <br />
            先に登録またはログインしてください。
          </div>
        ) : null}

        <div style={styles.card}>
          <label style={styles.dropArea}>
            <input
              type="file"
              accept="image/*"
              onChange={handleImageChange}
              style={{ display: "none" }}
            />
            <span style={styles.dropTitle}>画像を選ぶ</span>
            <span style={styles.dropText}>
              会話スクショ以外でも大丈夫です。いま気になっている画面を選んでください。
            </span>
          </label>

          {imageName ? <p style={styles.fileName}>選択中：{imageName}</p> : null}

          {previewUrl ? (
            <div style={styles.previewBox}>
              <img
                src={previewUrl}
                alt="選択した画像"
                style={styles.previewImage}
              />
            </div>
          ) : null}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              ...styles.primaryButton,
              background: canSubmit
                ? "linear-gradient(135deg, #bfa7ff 0%, #7d8cff 100%)"
                : "#e5e1ef",
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {submitting ? "Muがイマジナルを見ています..." : "Muに診断してもらう"}
          </button>

          {error ? <p style={styles.error}>{error}</p> : null}
        </div>

        {diagnosis ? (
          <div style={styles.resultCard}>
            <p style={styles.resultKicker}>Muのイマジナル診断</p>
            <p style={styles.resultText}>{diagnosis}</p>

            <div style={styles.followupBox}>
              <p style={styles.followupTitle}>この診断について、Muに聞いてみる</p>
              <p style={styles.followupNote}>
                Phase 1では質問ボタンの表示までです。回答APIは次の実装で接続します。
              </p>

              <div style={styles.questionList}>
                {FOLLOWUP_QUESTIONS.map((question, index) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => setSelectedQuestion(`${index + 1}. ${question}`)}
                    style={styles.questionButton}
                  >
                    {index + 1}. {question}
                  </button>
                ))}
              </div>

              {selectedQuestion ? (
                <p style={styles.selectedQuestion}>
                  選択中：{selectedQuestion}
                </p>
              ) : null}

              {diagnosisLogId ? (
                <p style={styles.savedNote}>
                  診断は保存されました。ID: {diagnosisLogId}
                </p>
              ) : null}

              {diagnosisSeed ? (
                <details style={styles.seedDetails}>
                  <summary>診断Seedを確認する</summary>
                  <pre style={styles.seedPre}>
                    {JSON.stringify(diagnosisSeed, null, 2)}
                  </pre>
                </details>
              ) : null}
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
    background: "linear-gradient(180deg, #f7f8ff 0%, #f6f1ec 58%, #ffffff 100%)",
    display: "flex",
    justifyContent: "center",
    padding: "24px 16px",
  },
  container: {
    width: "100%",
    maxWidth: 430,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  heroCard: {
    borderRadius: 24,
    background: "rgba(255,255,255,0.92)",
    padding: "24px 20px",
    boxShadow: "0 18px 48px rgba(126,112,255,0.10)",
    border: "1px solid rgba(150,135,255,0.16)",
  },
  kicker: {
    margin: 0,
    color: "#9a6b45",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.08em",
  },
  title: {
    margin: "12px 0 0",
    color: "#2d241f",
    fontSize: 25,
    lineHeight: 1.35,
    letterSpacing: "-0.03em",
  },
  lead: {
    margin: "16px 0 0",
    color: "#5d514a",
    fontSize: 14,
    lineHeight: 1.8,
  },
  leadSmall: {
    margin: "10px 0 0",
    color: "#7a6b62",
    fontSize: 13,
    lineHeight: 1.75,
  },
  notice: {
    borderRadius: 20,
    background: "rgba(246,242,255,0.96)",
    color: "#4e4378",
    padding: "14px 16px",
    fontSize: 14,
    lineHeight: 1.7,
  },
  card: {
    borderRadius: 24,
    background: "rgba(255,255,255,0.92)",
    padding: 18,
    boxShadow: "0 14px 36px rgba(126,112,255,0.10)",
    border: "1px solid rgba(150,135,255,0.16)",
  },
  dropArea: {
    display: "block",
    border: "1.5px dashed rgba(150,135,255,0.30)",
    borderRadius: 20,
    padding: 18,
    textAlign: "center",
    cursor: "pointer",
    background: "rgba(250,248,255,0.96)",
  },
  dropTitle: {
    display: "block",
    color: "#2d241f",
    fontSize: 15,
    fontWeight: 700,
  },
  dropText: {
    display: "block",
    marginTop: 8,
    color: "#8b817b",
    fontSize: 12,
    lineHeight: 1.6,
  },
  fileName: {
    margin: "12px 0 0",
    color: "#4e4378",
    fontSize: 13,
    lineHeight: 1.6,
  },
  previewBox: {
    marginTop: 14,
    borderRadius: 18,
    overflow: "hidden",
    border: "1px solid rgba(0,0,0,0.08)",
    background: "#eeeeee",
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
    color: "#ffffff",
    fontSize: 16,
    fontWeight: 700,
  },
  error: {
    margin: "12px 0 0",
    color: "#b3261e",
    fontSize: 13,
    lineHeight: 1.7,
  },
  resultCard: {
    borderRadius: 24,
    background: "rgba(255,255,255,0.92)",
    padding: "20px 18px",
    boxShadow: "0 14px 36px rgba(126,112,255,0.10)",
    border: "1px solid rgba(150,135,255,0.16)",
  },
  resultKicker: {
    margin: 0,
    color: "#9a6b45",
    fontSize: 13,
    fontWeight: 700,
  },
  resultText: {
    margin: "12px 0 0",
    color: "#2d241f",
    fontSize: 15,
    lineHeight: 1.9,
    whiteSpace: "pre-wrap",
  },
  followupBox: {
    marginTop: 22,
    borderTop: "1px solid rgba(45,36,31,0.1)",
    paddingTop: 18,
  },
  followupTitle: {
    margin: 0,
    color: "#2d241f",
    fontSize: 15,
    fontWeight: 700,
    lineHeight: 1.7,
  },
  followupNote: {
    margin: "6px 0 0",
    color: "#8b817b",
    fontSize: 12,
    lineHeight: 1.7,
  },
  questionList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginTop: 12,
  },
  questionButton: {
    width: "100%",
    border: "1px solid rgba(150,135,255,0.20)",
    borderRadius: 14,
    padding: "10px 12px",
    background: "rgba(250,248,255,0.96)",
    color: "#2d241f",
    textAlign: "left",
    fontSize: 13,
    lineHeight: 1.6,
    cursor: "pointer",
  },
  selectedQuestion: {
    margin: "12px 0 0",
    color: "#4e4378",
    fontSize: 13,
    lineHeight: 1.6,
  },
  savedNote: {
    margin: "12px 0 0",
    color: "#8b817b",
    fontSize: 12,
    lineHeight: 1.6,
  },
  seedDetails: {
    marginTop: 12,
    color: "#6b5a80",
    fontSize: 12,
  },
  seedPre: {
    marginTop: 8,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflow: "auto",
    maxHeight: 260,
    background: "rgba(246,242,255,0.76)",
    borderRadius: 12,
    padding: 10,
  },
  backLink: {
    textAlign: "center",
    color: "#8b817b",
    fontSize: 13,
    textDecoration: "none",
    padding: "8px 0",
  },
};
