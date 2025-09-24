// components/KnowledgeModal.tsx
'use client';
import { useState, useEffect } from 'react';

type KnowledgeItem = {
  area: string;
  intent: string;
  title: string;
  content: string;
  actions: { href: string; label: string }[];
  tags: string[];
};

export default function KnowledgeModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [toc, setToc] = useState<{ area: string; titles: string[] }[]>([]);
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);

  // 目次ロード
  useEffect(() => {
    if (open) {
      fetch('/api/knowledge/toc')
        .then((r) => r.json())
        .then((data) => setToc(data.items || []));
    }
  }, [open]);

  const search = async () => {
    if (!q.trim()) return;
    const res = await fetch(`/api/knowledge/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    setItems(data.items);
    setSelected(null);
  };

  const loadByTitle = async (title: string) => {
    const res = await fetch(`/api/knowledge/get?title=${encodeURIComponent(title)}`);
    const data = await res.json();
    setSelected(data.item);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-lg w-[min(900px,94vw)] max-h-[85vh] overflow-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Q&Aナレッジ</h2>
          <button className="text-gray-500 hover:text-black" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 検索バー */}
        <div className="flex gap-2 mb-4">
          <input
            className="flex-1 border rounded px-3 py-2"
            placeholder="キーワード検索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            className="border rounded px-3 py-2 bg-gray-100 hover:bg-gray-200"
            onClick={search}
          >
            検索
          </button>
          <span className="ml-2 text-xs px-2 py-1 rounded bg-green-100 text-green-700">
            無料
          </span>
        </div>

        <div className="flex gap-6">
          {/* 目次（Accordion） */}
          <div className="w-1/3 border-r pr-3">
            {toc.map((section, i) => (
              <details key={i} className="mb-2">
                <summary className="cursor-pointer font-medium">
                  {section.area}
                </summary>
                <ul className="ml-3 mt-1 space-y-1 text-sm">
                  {section.titles.map((t, idx) => (
                    <li key={idx}>
                      <button
                        className="underline text-blue-600"
                        onClick={() => loadByTitle(t)}
                      >
                        {t}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>

          {/* 回答エリア */}
          <div className="flex-1">
            {selected ? (
              <div className="border rounded-lg p-3">
                <div className="font-medium">{selected.title}</div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">
                  {selected.content}
                </p>
                {Array.isArray(selected.actions) &&
                  selected.actions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selected.actions.map((a, idx) => (
                        <a
                          key={idx}
                          href={a.href}
                          className="text-sm underline text-blue-600"
                        >
                          {a.label}
                        </a>
                      ))}
                    </div>
                  )}
              </div>
            ) : items.length > 0 ? (
              items.map((it, i) => (
                <div key={i} className="border rounded-lg p-3 mb-3">
                  <div className="font-medium">{it.title}</div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">
                    {it.content}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-gray-500">目次から選ぶか検索してください。</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
