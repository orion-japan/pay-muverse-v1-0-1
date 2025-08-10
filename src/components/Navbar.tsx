// 例: Navbar.tsx
import Link from 'next/link'
import Image from 'next/image'

export default function Navbar() {
  return (
    <nav className="flex justify-around bg-white border-t border-gray-200 py-2">
      {/* Home */}
      <Link href="/" className="flex flex-col items-center">
        <Image src="/home.png" alt="Home" width={28} height={28} />
        <span className="text-xs mt-1">Home</span>
      </Link>

      {/* Mu_AI */}
      <Link href="/mu_ai" className="flex flex-col items-center">
        <Image src="/mu_ai.png" alt="Mu AI" width={28} height={28} />
        <span className="text-xs mt-1">Mu_AI</span>
      </Link>

      {/* 共鳴会 LIVE */}
      <Link href="/kyomeikai/live" className="flex flex-col items-center">
        <Image src="/live.png" alt="LIVE" width={28} height={28} />
        <span className="text-xs mt-1">LIVE</span>
      </Link>

      {/* プラン */}
      <Link href="/plan" className="flex flex-col items-center">
        <Image src="/plan.png" alt="Plan" width={28} height={28} />
        <span className="text-xs mt-1">プラン</span>
      </Link>
    </nav>
  )
}
