// src/app/knowledge/page.tsx
import { Suspense } from 'react'
import KnowledgeClient from './KnowledgeClient'

export const dynamic = 'force-dynamic' // ← プリレンダー回避
export const revalidate = 0            // ← 必要に応じて調整

export default function Page() {
  return (
    <Suspense fallback={<div />}>
      <KnowledgeClient />
    </Suspense>
  )
}
