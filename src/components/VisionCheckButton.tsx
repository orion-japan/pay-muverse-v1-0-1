// src/components/VisionCheckButton.tsx
'use client'

import { useState } from 'react'

export default function VisionCheckButton({ visionId, userCode }: { visionId: string, userCode: string }) {
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleComplete = async () => {
    if (!userCode) {
      alert('ログインしてください')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/qcode/vision/check/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vision_id: visionId,      // VisionのID
          user_code: userCode,      // ユーザー
          intent: 'vision-check',   // Qコード intent
          extra: { source: 'Vision完了ボタン' } // 任意メタ情報
        }),
      })

      if (!res.ok) throw new Error('保存に失敗しました')
      const data = await res.json()
      console.log('Qコード保存結果:', data)

      setDone(true)
    } catch (e: any) {
      console.error(e)
      alert(e.message || 'エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleComplete}
      disabled={loading || done}
      style={{
        padding: '10px 16px',
        borderRadius: 8,
        background: done ? '#ccc' : '#0070f3',
        color: '#fff',
        border: 'none',
        cursor: done ? 'default' : 'pointer',
      }}
    >
      {done ? '完了済み ✅' : loading ? '保存中…' : '完了する'}
    </button>
  )
}
