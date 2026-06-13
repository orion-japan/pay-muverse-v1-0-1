export default function TikTokRadarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background: "#f7f7f8",
      }}
    >
      {children}
    </div>
  );
}
