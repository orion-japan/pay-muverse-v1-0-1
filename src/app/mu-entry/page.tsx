"use client";

import Link from "next/link";

export default function MuEntryPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #fff7f0 0%, #ffffff 55%, #f7f7f8 100%)",
        display: "flex",
        justifyContent: "center",
        padding: "32px 16px",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 430,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <div
          style={{
            borderRadius: 28,
            background: "rgba(255,255,255,0.92)",
            boxShadow: "0 18px 50px rgba(0,0,0,0.08)",
            padding: "28px 22px",
            border: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 13,
              letterSpacing: "0.08em",
              color: "#9a6b45",
              fontWeight: 700,
            }}
          >
            Muverse
          </p>

          <h1
            style={{
              margin: "14px 0 0",
              fontSize: 28,
              lineHeight: 1.32,
              color: "#2d241f",
              letterSpacing: "-0.03em",
            }}
          >
            まずは、あなたの今を
            <br />
            Muに映してみる
          </h1>

          <p
            style={{
              margin: "18px 0 0",
              fontSize: 15,
              lineHeight: 1.9,
              color: "#5d514a",
            }}
          >
            スクリーンショットを1枚送るだけで、Muが今の流れや関係性のズレを読み取り、
            最初の診断として言葉にします。
          </p>

          <div
            style={{
              marginTop: 22,
              padding: "14px 16px",
              borderRadius: 18,
              background: "#fff4e8",
              color: "#6d4b31",
              fontSize: 14,
              lineHeight: 1.7,
            }}
          >
            初回登録で、Muとの会話90クレジットと、スクショ診断1回分が付与されます。
          </div>

          <div
            style={{
              marginTop: 24,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <Link
              href="/register"
              style={{
                display: "block",
                textAlign: "center",
                textDecoration: "none",
                borderRadius: 999,
                padding: "15px 18px",
                background: "#2d241f",
                color: "#ffffff",
                fontSize: 16,
                fontWeight: 700,
              }}
            >
              無料ではじめる
            </Link>

            <Link
              href="/mu-first"
              style={{
                display: "block",
                textAlign: "center",
                textDecoration: "none",
                borderRadius: 999,
                padding: "14px 18px",
                background: "#ffffff",
                color: "#2d241f",
                border: "1px solid rgba(45,36,31,0.16)",
                fontSize: 15,
                fontWeight: 700,
              }}
            >
              登録済みの方はこちら
            </Link>
          </div>
        </div>

        <p
          style={{
            margin: 0,
            textAlign: "center",
            color: "#8b817b",
            fontSize: 12,
            lineHeight: 1.7,
          }}
        >
          Muは、あなたの状態を決めつけるものではありません。
          <br />
          いま起きている流れを、見える形にするための入口です。
        </p>
      </section>
    </main>
  );
}
