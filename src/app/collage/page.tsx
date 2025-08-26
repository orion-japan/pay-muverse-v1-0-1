'use client';

import IboardCollageMaker from '../../components/IboardCollageMaker';

export default function CollagePage() {
  return (
    <div style={{ padding: 16 }}>
      <h2>コラージュ作成</h2>
      {/* そのままレンダリング（props不要） */}
      <IboardCollageMaker />
    </div>
  );
}
