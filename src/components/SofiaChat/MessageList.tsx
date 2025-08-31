'use client';

import type { Message } from 'types';

export default function MessageList({ messages }: { messages: Message[] }) {
  return (
    <div className="sof-msgs">
      {messages.length === 0 ? (
        <div className="sof-empty">ここに会話が表示されます</div>
      ) : (
        messages.map((m) => (
          <div
            key={m.id}
            className={`sof-bubble ${m.role === 'user' ? 'is-user' : 'is-assistant'}`}
          >
            {m.uploaded_image_urls?.length ? (
              <div className="sof-bubble__imgs">
                {m.uploaded_image_urls.map((u, i) => (
                  <img key={i} src={u} alt="" />
                ))}
              </div>
            ) : null}
            <div className="sof-bubble__role">{m.role}</div>
            <div className="sof-bubble__text">{m.content}</div>
          </div>
        ))
      )}
    </div>
  );
}
