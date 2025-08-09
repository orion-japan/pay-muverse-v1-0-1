import React from "react";
import Link from "next/link";
import s from "../styles/layout.module.css";

type Props = { children: React.ReactNode };

export default function AppShell({ children }: Props) {
  return (
    <div className="page">
      <header className={`${s.header} ${s.sticky}`}>
        <div className={`container ${s.headerInner}`}>
          <div className={s.brand}>
            <span>🏠</span>
            <b>Muverse</b>
          </div>
          <nav className={s.topNav}>
            <Link href="/me">My</Link>
            <Link href="/social">SNS</Link>
            <Link href="/events">共鳴会</Link>
            <button className={s.logout}>ログアウト</button>
          </nav>
        </div>
      </header>

      <main className="container" style={{ paddingTop: 12 }}>
        {children}
      </main>

      <nav className={s.tabbar}>
        <div className={s.tabInner}>
          <Link className={s.tabLink} href="/">
            <span>🏠</span>
            <small>Home</small>
          </Link>
          <Link className={s.tabLink} href="/social">
            <span>💬</span>
            <small>SNS</small>
          </Link>
          <Link className={s.tabLink} href="/post">
            <span>📝</span>
            <small>投稿</small>
          </Link>
          <Link className={s.tabLink} href="/me">
            <span>👤</span>
            <small>My</small>
          </Link>
        </div>
      </nav>
    </div>
  );
}
