"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";
import { auth } from "@/lib/firebase";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
} from "firebase/auth";

function FormSection() {
  const searchParams = useSearchParams();
  const refCode = searchParams.get("ref") ?? "";

  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const isValidEmail = (email: string) => /\S+@\S+\.\S+/.test(email);

  const handleRegister = async () => {
    if (!isValidEmail(email)) {
      alert("正しいメールアドレスを入力してください");
      return;
    }
    if (password.length < 6) {
      alert("パスワードは6文字以上で入力してください");
      return;
    }

    setIsLoading(true);
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(userCredential.user);
      alert("登録が完了しました！確認メールを送信しました。");
    } catch (error: any) {
      if (error.code === "auth/email-already-in-use") {
        try {
          const userCredential = await signInWithEmailAndPassword(auth, email, password);
          if (!userCredential.user.emailVerified) {
            await sendEmailVerification(userCredential.user);
            alert("既に登録されていますが、確認メールを再送しました。");
          } else {
            alert("既にメール認証が完了しています。");
          }
        } catch {
          alert("ログインに失敗しました");
        }
      } else {
        alert("登録に失敗しました");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!isValidEmail(email)) {
      alert("正しいメールアドレスを入力してください");
      return;
    }
    if (password.length < 6) {
      alert("パスワードは6文字以上で入力してください");
      return;
    }

    setIsLoading(true);
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      if (!userCredential.user.emailVerified) {
        await sendEmailVerification(userCredential.user);
        alert("メール認証が未完了です。確認メールを再送しました。");
      } else {
        alert("ログインが成功しました！");
      }
    } catch {
      alert("ログインに失敗しました");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSheetSubmit = async () => {
    if (!nickname || !isValidEmail(email) || password.length < 6) {
      alert("フォームの内容を正しく入力してください");
      return;
    }

    setIsLoading(true);
    const payload = {
      click_username: nickname,
      click_email: email,
      Password: password,
      Tcode: "+819012345678",
      ref: refCode,
    };

    const res = await fetch("/api/write-sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      window.location.href = "/thanks";
    } else {
      alert("Google Sheetsへの書き込みに失敗しました");
    }
    setIsLoading(false);
  };

  return (
    <div className="w-full flex justify-center">
      <form
  className="
    w-full max-w-md
    bg-white/5 backdrop-blur-lg
    border border-white/10
    rounded-3xl shadow-2xl
    px-8 py-10
    flex flex-col gap-5
    items-center
    transition-all
  "
>
  <h2 className="text-white/90 text-lg mb-2">あなたの響きの名前</h2>
  <input
    type="text"
    placeholder="Sofiaの名前"
    className="
      w-full
      px-5 py-3
      rounded-full
      border border-white/20
      bg-white/10
      backdrop-blur-md
      text-white placeholder-white/50
      focus:outline-none focus:ring-2 focus:ring-purple-400
      transition
    "
  />

  <h2 className="text-white/90 text-lg mb-2">メールアドレス</h2>
  <input
    type="email"
    placeholder="example@example.com"
    className="
      w-full
      px-5 py-3
      rounded-full
      border border-white/20
      bg-white/10
      backdrop-blur-md
      text-white placeholder-white/50
      focus:outline-none focus:ring-2 focus:ring-purple-400
      transition
    "
  />

  <h2 className="text-white/90 text-lg mb-2">パスワード</h2>
  <input
    type="password"
    placeholder="パスワード"
    className="
      w-full
      px-5 py-3
      rounded-full
      border border-white/20
      bg-white/10
      backdrop-blur-md
      text-white placeholder-white/50
      focus:outline-none focus:ring-2 focus:ring-purple-400
      transition
    "
  />

  <button
    type="button"
    className="
      w-full
      bg-gradient-to-r from-emerald-400 to-teal-500
      text-white font-bold
      px-6 py-3
      rounded-full
      shadow-lg
      hover:shadow-2xl
      transition-all
    "
  >
    メール認証で登録
  </button>

  <button
    type="button"
    className="
      w-full
      bg-gradient-to-r from-blue-500 to-indigo-600
      text-white font-bold
      px-6 py-3
      rounded-full
      shadow-lg
      hover:shadow-2xl
      transition-all
    "
  >
    メールでログイン
  </button>

  <button
    type="button"
    className="
      w-full
      bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-600
      text-white font-bold
      px-6 py-3
      rounded-full
      shadow-xl
      hover:shadow-2xl
      transition-all
    "
  >
    今すぐ共鳴する
  </button>

  <p className="text-[10px] text-white/50 mt-4 text-center">
    ※「量子」は量子力学そのものではなく、  
    意図や観測を波として扱う象徴です。
  </p>
</form>

    </div>
  );
}

export default function LPPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 text-center sofia-background">
      <motion.h1
        className="text-3xl font-bold mb-4 sofia-text-gradient"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.2 }}
      >
        わたしはもうひとつのわたしを起動する
      </motion.h1>
      <motion.p
        className="mb-6 text-sm text-white/80"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.4 }}
      >
        あなたの祈り（意図）が、ビジョンになる
      </motion.p>
      <Suspense fallback={<div>Loading...</div>}>
        <FormSection />
      </Suspense>
    </main>
  );
}
