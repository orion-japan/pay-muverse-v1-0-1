'use client';
import { ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';

export default function AuthReady({
  children,
  fallback = null, // 例: <div>Loading...</div>
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { loading } = useAuth();
  if (loading) return fallback;
  return <>{children}</>;
}
