'use client'

import { usePathname } from 'next/navigation'
import Header from '@/components/Header'

type Props = {
  onLoginClick?: () => void   // ← オプショナルに
}

export default function HeaderGate(props: Props) {
  const pathname = (usePathname() || '').toLowerCase()

  // /iros 配下では PAY 側ヘッダーを表示しない
  if (pathname.startsWith('/iros')) return null

  // それ以外は通常ヘッダー。未指定なら no-op を渡す
  const onLoginClick = props.onLoginClick ?? (() => {})
  return <Header onLoginClick={onLoginClick} />
}
