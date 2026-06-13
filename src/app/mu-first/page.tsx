"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { authedFetch, useAuth } from "@/context/AuthContext";

type DiagnosisResponse = {
  ok?: boolean;
  diagnosis?: string;
  error?: string;
  detail?: string;
  credit_consumed?: boolean | null;
  model?: string;
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("invalid_file_result"));
      }
    };

    reader.onerror = () => reject(reader.error || new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

export default function MuFirstPage() {
  const { user, loading } = useAuth();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [imageName, setImageName] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = useMemo(
    () => Boolean(previewUrl && selectedFile && user && !loading && !submitting),
    [previewUrl, selectedFile, user, loading, submitting],
  );

  function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      setSelectedFile(null);
      setImageName("");
      setPreviewUrl("");
      setDiagnosis("");
      setError("");
      return;
    }

    setSelectedFile(file);
    setImageName(file.name);
    setPreviewUrl(URL.createObjectURL(file));
    setDiagnosis("");
    setError("");
  }

  async function handleSubmit() {
    if (!canSubmit || !selectedFile) return;

    setSubmitting(true);
    setDiagnosis("");
    setError("");

    try {
      const imageDataUrl = await fileToDataUrl(selectedFile);

      const res = await authedFetch("/api/mu/first-diagnosis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_data_url: imageDataUrl,
          source: "mu_first",
        }),
      });

      const data = (await res.json().catch(() => ({}))) as DiagnosisResponse;

      if (!res.ok || !data.ok) {
        const message =
          data.error === "no_screenshot_credit"
            ? "スクショ診断クレジットがありません。"
            : data.error === "invalid_image"
              ? "画像を読み取れませんでした。別の画像でお試しください。"
              : data.error === "missing_openai_api_key"
                ? "OpenAI APIキーが未設定です。"
                : data.error === "llm_failed"
                  ? "診断生成でエラーが起きました。"
                  : data.error || "診断に失敗しました。";

        setError(message);
        return;
      }

      setDiagnosis(data.diagnosis || "");
    } catch (e: any) {
      setError(e?.message || "診断に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f7f7f8",
        display: "flex",
        justifyContent: "center",
        padding: "24px 16px",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 430,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div
          style={{
            borderRadius: 24,
            background: "#ffffff",
            padding: "24px 20px",
            boxShadow: "0 16px 40px rgba(0,0,0,0.07)",
            border: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <p
            style={{
              margin: 0,
              color: "#9a6b45",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.08em",
            }}
          >
            First Diagnosis
          </p>

          <h1
            style={{
              margin: "12px 0 0",
              color: "#2d241f",
              fontSize: 25,
              lineHeight: 1.35,
              letterSpacing: "-0.03em",
            }}
          >
            スクショを1枚送って、
            <br />
            Muの初回診断を受ける
          </h1>

          <p
            style={{
              margin: "16px 0 0",
              color: "#5d514a",
              fontSize: 14,
              lineHeight: 1.8,
            }}
          >
            LINE、SNS、メモ、やり取りの一部など、今気になっている画面を1枚選んでください。
            Muがその状態を読み取り、最初の言葉にします。
          </p>
        </div>

        {!loading && !user ? (
          <div
            style={{
              borderRadius: 20,
              background: "#fff4e8",
              color: "#6d4b31",
              padding: "14px 16px",
              fontSize: 14,
              lineHeight: 1.7,
            }}
          >
            初回診断を使うにはログインが必要です。
            <br />
            先に登録またはログインしてください。
          </div>
        ) : null}

        <div
          style={{
            borderRadius: 24,
            background: "#ffffff",
            padding: 18,
            boxShadow: "0 12px 30px rgba(0,0,0,0.06)",
            border: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <label
            style={{
              display: "block",
              border: "1.5px dashed rgba(45,36,31,0.26)",
              borderRadius: 20,
              padding: 18,
              textAlign: "center",
              cursor: "pointer",
              background: "#fffaf5",
            }}
          >
            <input
              type="file"
              accept="image/*"
              onChange={handleImageChange}
              style={{ display: "none" }}
            />

            <span
              style={{
                display: "block",
                color: "#2d241f",
                fontSize: 15,
                fontWeight: 700,
              }}
            >
              スクリーンショットを選ぶ
            </span>

            <span
              style={{
                display: "block",
                marginTop: 8,
                color: "#8b817b",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              画像は初回診断にだけ使います。
            </span>
          </label>

          {imageName ? (
            <p
              style={{
                margin: "12px 0 0",
                color: "#6d4b31",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              選択中：{imageName}
            </p>
          ) : null}

          {previewUrl ? (
            <div
              style={{
                marginTop: 14,
                borderRadius: 18,
                overflow: "hidden",
                border: "1px solid rgba(0,0,0,0.08)",
                background: "#eeeeee",
              }}
            >
              <img
                src={previewUrl}
                alt="選択したスクリーンショット"
                style={{
                  display: "block",
                  width: "100%",
                  height: "auto",
                }}
              />
            </div>
          ) : null}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              width: "100%",
              marginTop: 16,
              border: "none",
              borderRadius: 999,
              padding: "15px 18px",
              background: canSubmit ? "#2d241f" : "#d9d5d2",
              color: "#ffffff",
              fontSize: 16,
              fontWeight: 700,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {submitting ? "診断しています..." : "Muに診断してもらう"}
          </button>

          {error ? (
            <p
              style={{
                margin: "12px 0 0",
                color: "#b3261e",
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              {error}
            </p>
          ) : null}
        </div>

        {diagnosis ? (
          <div
            style={{
              borderRadius: 24,
              background: "#ffffff",
              padding: "20px 18px",
              boxShadow: "0 12px 30px rgba(0,0,0,0.06)",
              border: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            <p
              style={{
                margin: 0,
                color: "#9a6b45",
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              Muの初回診断
            </p>

            <p
              style={{
                margin: "12px 0 0",
                color: "#2d241f",
                fontSize: 15,
                lineHeight: 1.9,
                whiteSpace: "pre-wrap",
              }}
            >
              {diagnosis}
            </p>

            <Link
              href="/mu"
              style={{
                display: "block",
                marginTop: 18,
                textAlign: "center",
                textDecoration: "none",
                borderRadius: 999,
                padding: "14px 18px",
                background: "#2d241f",
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 700,
              }}
            >
              Muと話す
            </Link>
          </div>
        ) : null}

        <Link
          href="/mu-entry"
          style={{
            textAlign: "center",
            color: "#8b817b",
            fontSize: 13,
            textDecoration: "none",
            padding: "8px 0",
          }}
        >
          入口に戻る
        </Link>
      </section>
    </main>
  );
}
