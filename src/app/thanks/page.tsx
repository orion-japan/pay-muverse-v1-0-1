"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { auth } from "@/lib/firebase";

// === LPContinuationSection ===
function LPContinuationSection() {
  return (
    <section className="w-full">
      {/* 上に余白＋帯状の模様線 */}
      <div className="w-full h-4 mt-20 bg-gradient-to-r from-purple-400 via-pink-400 to-indigo-500 bg-[length:200%_200%] animate-[gradientShift_5s_ease-in-out_infinite] rounded-full shadow-lg" />

      <iframe
        src="https://3.muverse.jp/"
        title="Muverse - 思い出す空間、もうひとつのわたしへ"
        className="w-full h-[800px] border-0"
        loading="lazy"
      />

      <style jsx>{`
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `}</style>
    </section>
  );
}

export default function ThanksPage() {
  return (
    <>
      <main className="relative min-h-screen flex flex-col items-center justify-center p-8 text-center overflow-hidden">
        {/* 背景グラデーション */}
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-900 via-purple-900 to-black"></div>
        
        {/* 光の効果 */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-purple-900/20 via-transparent to-transparent opacity-10"></div>
        
        {/* メインコンテンツ */}
        <motion.div
          className="relative z-10 max-w-2xl mx-auto"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.2, ease: "easeOut" }}
        >
          <motion.div
            className="mb-8"
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
          >
            <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full flex items-center justify-center">
              <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </motion.div>

          <motion.h1
            className="text-4xl md:text-5xl font-bold mb-6 bg-gradient-to-r from-white via-purple-200 to-pink-200 bg-clip-text text-transparent"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1.4, delay: 0.5 }}
          >
            共鳴が始まりました
          </motion.h1>
          
          <motion.p
            className="text-xl text-white/90 mb-8 font-light"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1.4, delay: 0.7 }}
          >
            あなたの意図が、ビジョンに変わる瞬間です
          </motion.p>

          <motion.div
            className="p-6 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/20"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1.4, delay: 0.9 }}
          >
            <p className="text-white/80 mb-4">以下よりアプリにお入りください</p>
            <p className="text-white/80 mb-4">登録に５分ほどお時間をいただきます</p>
            <motion.a
              href="https://muverse.jp/?modalTransition=TRANSITION_PUSH&target=6d5196f439488&targetModal=&transition=TRANSITION_PUSH"
              className="inline-block bg-gradient-to-r from-purple-600 via-pink-600 to-indigo-600 hover:from-purple-500 hover:via-pink-500 hover:to-indigo-500 px-8 py-3 rounded-xl font-medium text-white shadow-lg transition-all duration-300"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              https://muverse.jp/
            </motion.a>
          </motion.div>
        </motion.div>
      </main>

      {/* LPの続きセクション */}
      <LPContinuationSection />
    </>
  );
}
