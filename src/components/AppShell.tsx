import React from "react";
import s from "../styles/layout.module.css";

export default function AppShell({children}:{children:React.ReactNode}){
  return (
    <div className="page">
      <header className={`${s.header} ${s.sticky}`}>
        <div className={`container ${s.headerInner}`}>
          <div className={s.brand}><span>🏠</span><b>Muverse</b></div>
          <nav className={s.topNav}>
            <a href="/me">My</a>
            <a href="/social">SNS</a>
            <a href="/events">共鳴会</a>
            <button className={s.logout}>ログアウト</button>
          </nav>
        </div>
      </header>

      <main className="container" style={{paddingTop:12}}>{children}</main>

      <nav className={s.tabbar}>
        <div className={s.tabInner}>
          <a className={s.tabLink} href="/"><span>🏠</span><small>Home</small></a>
          <a className={s.tabLink} href="/social"><span>💬</span><small>SNS</small></a>
          <a className={s.tabLink} href="/post"><span>📝</span><small>投稿</small></a>
          <a className={s.tabLink} href="/me"><span>👤</span><small>My</small></a>
        </div>
      </nav>
    </div>
  );
}
