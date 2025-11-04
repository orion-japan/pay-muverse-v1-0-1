import './event.css';

export const dynamic = 'force-dynamic';

export default function EventHubPage() {
  return (
    <div className="km-wrap">
      <div className="km-card">
        <div className="km-card-title">Event</div>
        <p className="km-hub-desc">
          よく使うメニューを選んでください。（画像と説明は後で差し替え）
        </p>

        <div className="km-hlist">
          <a href="/event/calendar" className="km-hcard" aria-label="カレンダー・履歴">
            <div className="km-hthumb">📅</div>
            <div className="km-hbody">
              <div className="km-htitle">カレンダー・履歴</div>
              <div className="km-hdesc">参加日・イベント履歴の確認とCSVダウンロード</div>
            </div>
            <div className="km-hcta">開く →</div>
          </a>

          <a href="/event/kyomeikai" className="km-hcard" aria-label="共鳴会">
            <div className="km-hthumb">🌀</div>
            <div className="km-hbody">
              <div className="km-htitle">共鳴会</div>
              <div className="km-hdesc">次回スケジュール確認／開始±10分で出席カウント</div>
            </div>
            <div className="km-hcta">開く →</div>
          </a>

          <a href="/event/meditation" className="km-hcard" aria-label="瞑想">
            <div className="km-hthumb">🧘</div>
            <div className="km-hbody">
              <div className="km-htitle">瞑想（愛祈）</div>
              <div className="km-hdesc">平日 05:50–06:30 OPEN／開始±10分で出席カウント</div>
            </div>
            <div className="km-hcta">開く →</div>
          </a>

          <a href="/event/live" className="km-hcard" aria-label="LIVE">
            <div className="km-hthumb">🎥</div>
            <div className="km-hbody">
              <div className="km-htitle">LIVE</div>
              <div className="km-hdesc">ブラウザから視聴（マイク・カメラは無効）</div>
            </div>
            <div className="km-hcta">開く →</div>
          </a>
        </div>
      </div>
    </div>
  );
}
