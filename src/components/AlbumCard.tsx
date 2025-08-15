// components/AlbumCard.tsx
export default function AlbumCard({ post, onClick }: any) {
    return (
      <div className="album-card" onClick={onClick}>
        <img src={post.media_urls?.[0]} alt={post.title} className="album-image" />
      </div>
    );
  }
  