export default function MuAiLayout({ children }) {
    return (
      // ✅ <html> や <body> は入れない！
      <div style={{ width: '100%', height: '100vh' }}>
        {children}  {/* Mu_AI の iframe */}
      </div>
    )
  }
  