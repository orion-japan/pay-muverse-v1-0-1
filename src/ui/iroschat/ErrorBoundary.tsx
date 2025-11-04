// /src/ui/iroschat/ErrorBoundary.tsx
'use client';

import React from 'react';
import styles from './index.module.css';

type State = { hasError: boolean; err?: any };

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(err: any): State {
    return { hasError: true, err };
  }

  componentDidCatch(err: any, info: any) {
    console.error('[Iros ErrorBoundary]', err, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.errorBox}>
          <h2>Iros: 一時的な問題が発生しました</h2>
          <p>ページを再読み込みして、もう一度お試しください。</p>
        </div>
      );
    }
    return this.props.children;
  }
}
