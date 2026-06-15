"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { authedFetch, useAuth } from "@/context/AuthContext";

type DiagnosisResponse = {
  ok?: boolean;
  diagnosis?: string;
  error?: string;
  detail?: string;
  credit_consumed?: boolean | null;
  model?: string;
  user_name_candidate?: string | null;
  followup_remaining?: number;
  followup_messages?: FollowupMessage[];
};

type FollowupResponse = {
  ok?: boolean;
  question?: string;
  answer?: string;
  code?: string;
  message?: string;
};

type FollowupMessage = {
  role: "user" | "assistant";
  content: string;
};

const FOLLOWUP_QUESTIONS = [
  "相手の反応から、今どんな流れが出ていますか？",
  "私がついやってしまう失敗やズレを見てください",
  "今、どう返すのが自然ですか？",
  "相手の本気度・向き合い方を見てください",
  "もっと深くMuに聞くと、どんなことがわかりますか？",
];

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

  const [followupInput, setFollowupInput] = useState("");
  const [followupError, setFollowupError] = useState("");
  const [followupSubmitting, setFollowupSubmitting] = useState(false);
  const [followupMessages, setFollowupMessages] = useState<FollowupMessage[]>([]);
  const [followupRemaining, setFollowupRemaining] = useState(3);
  const [nameCandidate, setNameCandidate] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [mainStarting, setMainStarting] = useState(false);

  const canSubmit = useMemo(
    () => Boolean(previewUrl && selectedFile && user && !loading && !submitting),
    [previewUrl, selectedFile, user, loading, submitting],
  );

  const canAskFollowup = useMemo(
    () =>
      Boolean(
        diagnosis &&
          user &&
          !loading &&
          !followupSubmitting &&
          followupInput.trim() &&
          followupRemaining > 0,
      ),
    [diagnosis, user, loading, followupSubmitting, followupInput, followupRemaining],
  );


  useEffect(() => {
    if (loading || !user || diagnosis || submitting) return;

    let cancelled = false;

    async function restoreLatestDiagnosis() {
      try {
        const res = await authedFetch("/api/mu/first-diagnosis", {
          method: "GET",
        });

        const data = (await res.json().catch(() => ({}))) as DiagnosisResponse;

        if (cancelled || !res.ok || !data.ok || !data.diagnosis) return;

        setDiagnosis(data.diagnosis || "");
        setNameCandidate(data.user_name_candidate || "");

        try {
          const savedPreviewUrl = sessionStorage.getItem("mu_first_preview_url");
          const savedImageName = sessionStorage.getItem("mu_first_image_name");

          if (savedPreviewUrl) {
            setPreviewUrl(savedPreviewUrl);
          }

          if (savedImageName) {
            setImageName(savedImageName);
          }
        } catch {
          // preview復元失敗時は無視
        }
        setNameSaved(false);
        setError("");

        if (Array.isArray(data.followup_messages)) {
          setFollowupMessages(
            data.followup_messages
              .filter((item) => item.role === "user" || item.role === "assistant")
              .map((item) => ({
                role: item.role,
                content: String(item.content || ""),
              }))
              .filter((item) => item.content),
          );
        }

        if (typeof data.followup_remaining === "number") {
          setFollowupRemaining(Math.max(0, data.followup_remaining));
        }
      } catch {
        // 復元失敗時は新規診断画面のままにする
      }
    }

    restoreLatestDiagnosis();

    return () => {
      cancelled = true;
    };
  }, [loading, user, diagnosis, submitting]);
  function resetFollowup() {
    setFollowupInput("");
    setFollowupError("");
    setFollowupSubmitting(false);
    setFollowupMessages([]);
    setFollowupRemaining(3);
  }

  async function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      setSelectedFile(null);
      setImageName("");
      setPreviewUrl("");
      try {
        sessionStorage.removeItem("mu_first_preview_url");
        sessionStorage.removeItem("mu_first_image_name");
      } catch {
        // preview削除失敗時は無視
      }
      setDiagnosis("");
      setError("");
      resetFollowup();
      return;
    }

    setSelectedFile(file);
    setImageName(file.name);

    try {
      const dataUrl = await fileToDataUrl(file);
      setPreviewUrl(dataUrl);
      sessionStorage.setItem("mu_first_preview_url", dataUrl);
      sessionStorage.setItem("mu_first_image_name", file.name);
    } catch {
      setPreviewUrl(URL.createObjectURL(file));
    }

    setDiagnosis("");
    setError("");
    resetFollowup();
  }

  async function handleSubmit() {
    if (!canSubmit || !selectedFile) return;

    setSubmitting(true);
    setDiagnosis("");
    setError("");
    resetFollowup();

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
      setNameCandidate(data.user_name_candidate || "");
      setNameSaved(false);
    } catch (e: any) {
      setError(e?.message || "診断に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }


  async function handleSaveName() {
    const name = nameCandidate.trim();
    if (!name || nameSaving) return;

    setNameSaving(true);
    try {
      const res = await authedFetch("/api/mu/first-name", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setFollowupError("名前の保存に失敗しました。");
        return;
      }

      setNameSaved(true);
    } catch {
      setFollowupError("名前の保存に失敗しました。");
    } finally {
      setNameSaving(false);
    }
  }

  async function handleGoMainMu() {
    if (mainStarting) return;

    setMainStarting(true);
    try {
      await authedFetch("/api/mu/first-onboarding/activate", {
        method: "POST",
      }).catch(() => null);
    } finally {
      window.location.href = "/mu";
    }
  }

  async function handleFollowupSubmit(message?: string) {
    const question = (message || followupInput).trim();
    if (!question || !diagnosis || followupSubmitting || followupRemaining <= 0) return;

    setFollowupSubmitting(true);
    setFollowupError("");

    const nextUserMessage: FollowupMessage = {
      role: "user",
      content: question,
    };

    try {
      const history = [...followupMessages, nextUserMessage];

      setFollowupMessages(history);
      setFollowupInput("");

      const res = await authedFetch("/api/mu/first-followup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: question,
          history: followupMessages,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as FollowupResponse;

      if (!res.ok || !data.ok) {
        const messageText =
          data.code === "no_first_followup_credit"
            ? "診断後の相談回数が残っていません。"
            : data.code === "missing_diagnosis"
              ? "先にスクショ診断を行ってください。"
              : data.message || "追加相談に失敗しました。";

        setFollowupError(messageText);

        if (data.code === "no_first_followup_credit") {
          setFollowupRemaining(0);
        }

        setFollowupMessages(followupMessages);
        return;
      }

      setFollowupMessages([
        ...history,
        {
          role: "assistant",
          content: data.answer || "",
        },
      ]);

      setFollowupRemaining((current) => Math.max(0, current - 1));
    } catch (e: any) {
      setFollowupError(e?.message || "追加相談に失敗しました。");
      setFollowupMessages(followupMessages);
    } finally {
      setFollowupSubmitting(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #f7f8ff 0%, #f4f1ff 48%, #ffffff 100%)",
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
            background: "rgba(255,255,255,0.9)",
            padding: "24px 20px",
            boxShadow: "0 18px 48px rgba(126,112,255,0.12)",
            border: "1px solid rgba(150,135,255,0.16)",
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
              background: "rgba(246,242,255,0.96)",
              color: "#4e4378",
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
            background: "rgba(255,255,255,0.9)",
            padding: 18,
            boxShadow: "0 14px 36px rgba(126,112,255,0.10)",
            border: "1px solid rgba(150,135,255,0.16)",
          }}
        >
          <label
            style={{
              display: "block",
              border: "1.5px dashed rgba(150,135,255,0.30)",
              borderRadius: 20,
              padding: 18,
              textAlign: "center",
              cursor: "pointer",
              background: "rgba(250,248,255,0.96)",
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
                color: "#4e4378",
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
              background: canSubmit ? "linear-gradient(135deg, #bfa7ff 0%, #7d8cff 100%)" : "#e5e1ef",
              color: "#ffffff",
              fontSize: 16,
              fontWeight: 700,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {submitting ? "Muがスクショを読んでいます..." : "Muに診断してもらう"}
          </button>

          {submitting ? (
            <p
              style={{
                margin: "10px 0 0",
                color: "#8b817b",
                fontSize: 12,
                lineHeight: 1.6,
                textAlign: "center",
              }}
            >
              10〜20秒ほどかかることがあります。
            </p>
          ) : null}

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
              background: "rgba(255,255,255,0.9)",
              padding: "20px 18px",
              boxShadow: "0 14px 36px rgba(126,112,255,0.10)",
              border: "1px solid rgba(150,135,255,0.16)",
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

            <div
              style={{
                marginTop: 22,
                borderTop: "1px solid rgba(45,36,31,0.1)",
                paddingTop: 18,
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: "#2d241f",
                  fontSize: 15,
                  fontWeight: 700,
                  lineHeight: 1.7,
                }}
              >
                この診断について、Muに聞いてみる
              </p>

              <p
                style={{
                  margin: "6px 0 0",
                  color: "#8b817b",
                  fontSize: 12,
                  lineHeight: 1.7,
                }}
              >
                番号を選ぶか、自由に質問してください。
              </p>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginTop: 12,
                }}
              >
                {FOLLOWUP_QUESTIONS.map((question, index) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => {
                      setFollowupInput(String(index + 1));
                    }}
                    disabled={followupSubmitting || followupRemaining <= 0}
                    style={{
                      width: "100%",
                      border: "1px solid rgba(150,135,255,0.20)",
                      borderRadius: 14,
                      padding: "10px 12px",
                      background: "rgba(250,248,255,0.96)",
                      color: "#2d241f",
                      textAlign: "left",
                      fontSize: 13,
                      lineHeight: 1.6,
                      cursor:
                        followupSubmitting || followupRemaining <= 0
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    {index + 1}. {question}
                  </button>
                ))}
              </div>

              {followupMessages.length ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    marginTop: 16,
                  }}
                >
                  {followupMessages.map((message, index) => (
                    <div
                      key={`${message.role}-${index}`}
                      style={{
                        alignSelf: message.role === "user" ? "flex-end" : "flex-start",
                        maxWidth: "92%",
                        borderRadius: 18,
                        padding: "10px 12px",
                        background:
                          message.role === "user" ? "rgba(246,242,255,0.98)" : "rgba(247,244,255,0.96)",
                        color: "#32234f",
                        fontSize: 13,
                        lineHeight: 1.7,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {message.content}
                    </div>
                  ))}
                </div>
              ) : null}

              <p
                style={{
                  margin: "14px 0 8px",
                  color: followupRemaining <= 0 ? "#7b5f95" : "#6b5a80",
                  fontSize: 12,
                  lineHeight: 1.6,
                  textAlign: "center",
                  fontWeight: followupRemaining <= 0 ? 700 : 500,
                }}
              >
                診断後の相談はあと{followupRemaining}回です。
              </p>

              <textarea
                value={followupInput}
                onChange={(event) => setFollowupInput(event.target.value)}
                placeholder="番号、または聞きたいことを入力"
                rows={3}
                disabled={followupSubmitting || followupRemaining <= 0}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  marginTop: 14,
                  borderRadius: 16,
                  border: "1px solid rgba(150,135,255,0.24)",
                  padding: "12px 13px",
                  resize: "vertical",
                  color: "#2d241f",
                  background: followupRemaining <= 0 ? "#f1efed" : "#ffffff",
                  fontSize: 14,
                  lineHeight: 1.6,
                  outline: "none",
                }}
              />

              <button
                type="button"
                onClick={() => handleFollowupSubmit()}
                disabled={!canAskFollowup}
                style={{
                  width: "100%",
                  marginTop: 10,
                  border: "none",
                  borderRadius: 999,
                  padding: "13px 16px",
                  background: canAskFollowup ? "linear-gradient(135deg, #bfa7ff 0%, #7d8cff 100%)" : "#e5e1ef",
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: canAskFollowup ? "pointer" : "not-allowed",
                }}
              >
                {followupSubmitting ? "Muが考えています..." : "Muに聞く"}
              </button>

              {followupError ? (
                <p
                  style={{
                    margin: "10px 0 0",
                    color: "#b3261e",
                    fontSize: 13,
                    lineHeight: 1.7,
                  }}
                >
                  {followupError}
                </p>
              ) : null}

              {followupRemaining <= 0 ? (
                <p
                  style={{
                    margin: "12px 0 0",
                    color: "#4e4378",
                    fontSize: 13,
                    lineHeight: 1.7,
                    textAlign: "center",
                  }}
                >
                  診断後の相談はここまでです。もっと深く話す場合は、Mu本体で続けてください。
                </p>
              ) : null}
            </div>

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
          {diagnosis && nameCandidate && (
            <div
              style={{
                borderRadius: 18,
                background: "rgba(247,244,255,0.95)",
                padding: "14px 14px",
                border: "1px solid rgba(150,135,255,0.20)",
              }}
            >
              <div style={{ fontSize: 13, color: "#6f5848", lineHeight: 1.7 }}>
                スクショ内では、あなたのお名前は「{nameCandidate}」のように見えます。
                この名前でMuに登録しますか？
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input
                  value={nameCandidate}
                  onChange={(event) => {
                    setNameCandidate(event.target.value);
                    setNameSaved(false);
                  }}
                  style={{
                    flex: 1,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.12)",
                    padding: "10px 12px",
                    fontSize: 14,
                  }}
                />
                <button
                  type="button"
                  onClick={handleSaveName}
                  disabled={nameSaving || !nameCandidate.trim()}
                  style={{
                    border: "none",
                    borderRadius: 12,
                    padding: "10px 12px",
                    background: "linear-gradient(135deg, #c8a7ff 0%, #7d8cff 100%)",
                    color: "#fff",
                    fontWeight: 700,
                  }}
                >
                  {nameSaving ? "保存中" : nameSaved ? "保存済" : "登録"}
                </button>
              </div>
            </div>
          )}
          {diagnosis && (
            <button
              type="button"
              onClick={handleGoMainMu}
              disabled={mainStarting}
              style={{
                width: "100%",
                border: "none",
                borderRadius: 18,
                padding: "15px 16px",
                background: "linear-gradient(135deg, #c8a7ff 0%, #7d8cff 100%)",
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 800,
                boxShadow: "0 14px 30px rgba(126,112,255,0.28)",
              }}
            >
              {mainStarting ? "Muへ接続中…" : "もっと深くMuに"}
            </button>
          )}
      </section>
    </main>
  );
}

