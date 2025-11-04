export default function PageHeader({
  title,
  subtitle,
  icon,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
}) {
  return (
    <div style={{ margin: '12px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {icon && <span style={{ fontSize: 20 }}>{icon}</span>}
        <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
      </div>
      {subtitle && <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>{subtitle}</div>}
    </div>
  );
}
