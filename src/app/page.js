"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";

function FormSection() {
  const searchParams = useSearchParams();
  const refCode = searchParams.get('ref') ?? '';

  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');

  const handleSubmit = async () => {
    const res = await fetch('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        nickname,
        email,
        password,
        phone_number: phone,
        ref: refCode,
        usertype: 'free'
      }),
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.ok) {
      window.location.href = '/thanks';
    } else {
      alert('登録に失敗しました');
    }
  };

  return (
    <>
      <input type="text" placeholder="ニックネーム" value={nickname} onChange={(e) => setNickname(e.target.value)} className="rounded border border-white/30 bg-white/10 backdrop-blur px-4 py-2 mb-2 w-full max-w-md focus:outline-none focus:ring-2 focus:ring-indigo-400" />
      <input type="email" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded border border-white/30 bg-white/10 backdrop-blur px-4 py-2 mb-2 w-full max-w-md focus:outline-none focus:ring-2 focus:ring-indigo-400" />
      <input type="password" placeholder="パスワード" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded border border-white/30 bg-white/10 backdrop-blur px-4 py-2 mb-2 w-full max-w-md focus:outline-none focus:ring-2 focus:ring-indigo-400" />
      <input type="tel" placeholder="SNS認証電話番号" value={phone} onChange={(e) => setPhone(e.target.value)} className="rounded border border-white/30 bg-white/10 backdrop-blur px-4 py-2 mb-4 w-full max-w-md focus:outline-none focus:ring-2 focus:ring-indigo-400" />
      <input type="hidden" value={refCode} />
      <button className="relative overflow-hidden bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 px-6 py-3 rounded-full shadow-lg transition-all before:absolute before:inset-0 before:bg-white/20 before:scale-0 hover:before:scale-150 before:rounded-full before:transition-transform before:duration-500" onClick={handleSubmit}>
        今すぐ共鳴する
      </button>
    </>
  );
}

export default function LPPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 text-center">
      <motion.h1
        className="text-4xl font-bold mb-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.2, ease: 'easeOut' }}
      >
        わたしはもうひとつのわたしを起動する
      </motion.h1>
      <motion.p
        className="mb-6 text-lg"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.4, ease: 'easeOut' }}
      >
        あなたの祈り（意図）が、ビジョンになる
      </motion.p>
      <p className="text-sm mb-8">※ここでいう『量子』とは量子力学そのものを指すものではなく、意図や観測を波動として扱う比喩的表現です。</p>

      <Suspense fallback={<div>Loading...</div>}>
        <FormSection />
      </Suspense>
    </main>
  );
}
