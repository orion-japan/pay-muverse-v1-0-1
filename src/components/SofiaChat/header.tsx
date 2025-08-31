'use client';

interface HeaderProps {
  title: string;
  isMobile?: boolean;
  onShowSideBar: () => void;
  onCreateNewChat: () => void;
}

export default function Header({
  title,
  onShowSideBar,
  onCreateNewChat,
}: HeaderProps) {
  return (
    <header className="sof-header">
      <button className="sof-btn" onClick={onShowSideBar}>メニュー</button>
      <h1 className="sof-header__title">{title}</h1>
      <button className="sof-btn primary" onClick={onCreateNewChat}>新規</button>
    </header>
  );
}
