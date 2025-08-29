import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number) {
  // month: 1-12, weekday: 0(Sun)-6(Sat)
  const first = new Date(year, month - 1, 1)
  const add = ( (7 + weekday - first.getDay()) % 7 ) + (nth - 1) * 7
  return new Date(year, month - 1, 1 + add)
}
function approximateVernalEquinoxDay(year: number) {
  // 1980-2099 に有効な近似式
  const day = Math.floor(20.8431 + 0.242194*(year - 1980) - Math.floor((year - 1980)/4))
  return new Date(year, 2, day) // March
}
function approximateAutumnalEquinoxDay(year: number) {
  const day = Math.floor(23.2488 + 0.242194*(year - 1980) - Math.floor((year - 1980)/4))
  return new Date(year, 8, day) // September
}

function pad2(n: number) { return `${n}`.padStart(2, '0') }
function fmt(d: Date) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}` }

function buildHolidays(year: number) {
  const list: { date: string; name: string }[] = []

  // 固定日
  list.push({ date: `${year}-01-01`, name: '元日' })
  list.push({ date: `${year}-02-11`, name: '建国記念の日' })
  list.push({ date: `${year}-02-23`, name: '天皇誕生日' })
  list.push({ date: `${year}-04-29`, name: '昭和の日' })
  list.push({ date: `${year}-05-03`, name: '憲法記念日' })
  list.push({ date: `${year}-05-04`, name: 'みどりの日' })
  list.push({ date: `${year}-05-05`, name: 'こどもの日' })
  list.push({ date: `${year}-08-11`, name: '山の日' })
  list.push({ date: `${year}-11-03`, name: '文化の日' })
  list.push({ date: `${year}-11-23`, name: '勤労感謝の日' })

  // ハッピーマンデー
  list.push({ date: fmt(nthWeekdayOfMonth(year, 1, 1, 2)), name: '成人の日' })        // 1月第2月曜
  list.push({ date: fmt(nthWeekdayOfMonth(year, 7, 1, 3)), name: '海の日' })          // 7月第3月曜
  list.push({ date: fmt(nthWeekdayOfMonth(year, 9, 1, 3)), name: '敬老の日' })        // 9月第3月曜
  list.push({ date: fmt(nthWeekdayOfMonth(year, 10, 1, 2)), name: 'スポーツの日' })   // 10月第2月曜

  // 春分・秋分（概算）
  list.push({ date: fmt(approximateVernalEquinoxDay(year)), name: '春分の日' })
  list.push({ date: fmt(approximateAutumnalEquinoxDay(year)), name: '秋分の日' })

  // ※振替休日・国民の休日は簡易化のため未対応（必要なら後日拡張）
  return list
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const y = Number(searchParams.get('year') || new Date().getFullYear())
    const m = searchParams.get('month') ? Number(searchParams.get('month')) : null

    const all = buildHolidays(y)
    const items = m
      ? all.filter(h => Number(h.date.slice(5,7)) === m)
      : all

    return NextResponse.json({ year: y, month: m ?? null, items })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'holiday failed' }, { status: 500 })
  }
}
