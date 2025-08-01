'use client'

// ✅ Props 型を export（Modal からも型補完される）
export type CardFormProps = {
  userCode: string
  onRegister: () => void
}

export const dynamic = 'force-dynamic'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import PlanSelectPanel from '@/components/PlanSelectPanel'
import CardStyle from '@/components/CardStyle'

const CardForm: React.FC<CardFormProps> = ({ userCode, onRegister }) => {
  const searchParams = useSearchParams()
  const user_code = searchParams.get('user') || userCode // ✅ propsの userCode と URL 両対応

  const [userData, setUserData] = useState<any>(null)
  const [payjp, setPayjp] = useState<any>(null)
  const [cardElement, setCardElement] = useState<any>(null) // ✅ ← card専用
  const [cardReady, setCardReady] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [cardRegistered, setCardRegistered] = useState(false)
  const [showCardForm, setShowCardForm] = useState(false)
  const [userCredit, setUserCredit] = useState<number>(0)

  /** ✅ ユーザーデータ取得 */
  const fetchStatus = async () => {
    console.log('🔍 [fetchStatus] START')
    try {
      const res = await fetch(`/api/account-status?user=${user_code}`)
      const json = await res.json()
      console.log('✅ [fetchStatus] API response:', json)

      setUserData(json)
      setCardRegistered(json.card_registered)
      setUserCredit(json.sofia_credit || 0)
    } catch (err) {
      console.error('⛔ [fetchStatus] ERROR:', err)
    }
  }

  useEffect(() => {
    if (user_code) fetchStatus()
  }, [user_code])

  /** ✅ PAY.JP 初期化 */
  const initPayjpCard = () => {
    console.log('▶ [initPayjpCard] START')

    if (payjp || cardElement || cardRegistered) {
      console.log('⚠️ [initPayjpCard] already initialized or card registered')
      return
    }

    console.log('📥 PAY.JP script loading...')
    const script = document.createElement('script')
    script.src = 'https://js.pay.jp/v2/pay.js'
    script.async = true

    script.onload = () => {
      console.log('✅ PAY.JP script loaded')

      const payjpInstance = (window as any).Payjp(
        process.env.NEXT_PUBLIC_PAYJP_PUBLIC_KEY!
      )
      setPayjp(payjpInstance)
      console.log('✅ payjp instance created')

      /** ✅ Elements 初期化 */
      const elements = payjpInstance.elements()

      /** ✅ 1つのカードElementを作成 */
      const card = elements.create('card')
      card.mount('#card-form')
      console.log('✅ card element mounted')

      setCardElement(card)
      setCardReady(true)
      console.log('✅ cardReady true')
    }

    script.onerror = () => {
      console.error('❌ PAY.JP script failed to load')
    }

    document.body.appendChild(script)
  }

  /** ✅ カード登録処理 */
  const handleCardRegistration = async () => {
    console.log('▶ [handleCardRegistration] START')
    setLoading(true)

    try {
      if (!payjp || !cardElement) {
        throw new Error('PAY.JP が初期化されていません')
      }

      console.log('📦 Calling payjp.createToken...')
      const result = await payjp.createToken(cardElement, {
        name: 'TARO YAMADA', // ✅ UIから取得するならここを差し替え
      })

      console.log('📦 payjp.createToken response:', result)

      if (result.error) {
        console.error('❌ Token creation error:', result.error)
        throw new Error(result.error.message)
      }

      const token = result.id
      console.log('✅ PAY.JP token:', token)

      console.log('📡 Calling /api/pay/account/register-card')
      const cardRes = await fetch('/api/pay/account/register-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code, token }),
      })

      const json = await cardRes.json()
      console.log('📩 register-card API response:', json)

      if (!cardRes.ok) {
        throw new Error('カード登録APIに失敗しました')
      }

      alert('✅ カードが登録されました')
      await fetchStatus()
      onRegister?.() // ✅ 成功時に親コンポーネントへ通知
    } catch (err: any) {
      console.error('❌ [handleCardRegistration] ERROR:', err)
      alert(err.message || 'カード登録に失敗しました')
    } finally {
      setLoading(false)
      console.log('▶ [handleCardRegistration] END')
    }
  }

  return (
    <main className="pay-main">
      <h1 className="pay-title">ご利用プラン</h1>

      <PlanSelectPanel
        userCode={user_code}
        cardRegistered={cardRegistered}
        userCredit={userCredit}
        onPlanSelected={(plan) => setSelectedPlan(plan)}
      />

      {!cardRegistered && (
        <>
          {!showCardForm ? (
            <div className="text-center mt-4">
              <button
                className="btn-card-register"
                onClick={() => {
                  console.log('▶ Card register button clicked')
                  setShowCardForm(true)
                  initPayjpCard()
                }}
              >
                カードを登録する
              </button>
            </div>
          ) : (
            <div>
              {/* ✅ ここに mount */}
              <div id="card-form" className="border p-3 rounded mb-4"></div>
              <div className="text-center mt-4">
                <button
                  onClick={handleCardRegistration}
                  disabled={!cardReady || loading}
                  className="btn-card-submit w-full"
                >
                  {loading ? 'カード登録中…' : 'このカードを登録する'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {cardRegistered && (
        <div className="registered-card-box text-center">
          <p className="text-gray-700">
            💳 登録済みカード: {userData?.card_brand || 'VISA'} ****{' '}
            {userData?.card_last4 || '****'}
          </p>
        </div>
      )}
    </main>
  )
}

export default CardForm
