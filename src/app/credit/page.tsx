'use client';

import { Suspense } from 'react';
import CreditRedirect from './CreditRedirect';

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CreditRedirect />
    </Suspense>
  );
}
