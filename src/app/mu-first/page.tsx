"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export default function MuFirstPage() {
  const [imageName, setImageName] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [diagnosis, setDiagnosis] = useState("");

  const canSubmit = useMemo(() => Boolean(previewUrl), [previewUrl]);

  function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      setImageName("");
      setPreviewUrl("");
      setDiagnosis("");
      return;
    }

    setImageName(file.name);
    setPreviewUrl(URL.createObjectURL(file));
    setDiagnosis("");
  }

  function handleSubmit() {
    if (!canSubmit) return;

    setDiagnosis(
      "この画面では、まだ本診断APIには接続していません。次の実装で、スクリーンショットをMuの初回診断APIへ送り、診断結果をここに表示します。"
    );
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
            Muに診断してもらう
          </button>
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
