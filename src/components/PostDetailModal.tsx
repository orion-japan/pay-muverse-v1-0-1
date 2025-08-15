'use client';
import PostModal from './PostModal';

export default function PostDetailModal({ post, onClose, onUpdated }: any) {
  const handleDelete = async () => {
    if (!confirm('削除しますか？')) return;
    await fetch('/api/delete-post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: post.post_id }),
    });
    onUpdated();
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>{post.title}</h3>
        <img src={post.media_urls?.[0]} alt={post.title} />
        <p>{post.content}</p>

        <div className="modal-actions">
          <button onClick={() => alert('編集モードでPostModalを開く')}>
            編集
          </button>
          <button onClick={handleDelete}>削除</button>
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
