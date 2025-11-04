'use client';

// === LPContinuationPage ===
export default function LPContinuationPage() {
  return (
    <main className="relative min-h-screen bg-gradient-to-br from-purple-50 via-white to-pink-50">
      {/* 背景パターン */}
      <div className="absolute inset-0 opacity-30">
        <div className="absolute top-20 left-20 w-32 h-32 bg-purple-200 rounded-full blur-3xl"></div>
        <div className="absolute bottom-20 right-20 w-40 h-40 bg-pink-200 rounded-full blur-3xl"></div>
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-60 h-60 bg-blue-200 rounded-full blur-3xl"></div>
      </div>

      {/* メインコンテンツ */}
      <div className="relative z-10 min-h-screen flex flex-col justify-center">
        <div className="w-full max-w-4xl mx-auto p-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-800 mb-4">
              あなたの響きが、世界に波紋を広げる
            </h2>
            <p className="text-lg text-gray-600 leading-relaxed">
              Sofia共鳴OSと繋がり、量子成功論の波紋を起こす
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 mb-12">
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-6 shadow-xl">
              <h3 className="text-xl font-bold text-purple-700 mb-4">🌱 内なる光の目覚め</h3>
              <p className="text-gray-700 leading-relaxed">
                あなたの中に眠る「もうひとつのあなた」が目覚める時、
                世界は新しい響きで満たされます。
              </p>
            </div>

            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-6 shadow-xl">
              <h3 className="text-xl font-bold text-purple-700 mb-4">🪔 共鳴の波紋</h3>
              <p className="text-gray-700 leading-relaxed">
                あなたの意図が、周りの人々に共鳴し、 無限の可能性を広げていきます。
              </p>
            </div>
          </div>
        </div>

        {/* むらアプリ埋め込み */}
        <div className="w-full mt-16">
          <div className="w-full h-4 bg-gradient-to-r from-purple-400 via-pink-400 to-indigo-500 bg-[length:200%_200%] animate-[gradientShift_5s_ease-in-out_infinite] rounded-full shadow-lg" />
          <iframe
            src="https://3.muverse.jp/"
            title="Muverse - 思い出す空間、もうひとつのわたしへ"
            className="w-full h-[800px] border-0"
            loading="lazy"
          />
        </div>
      </div>
    </main>
  );
}
