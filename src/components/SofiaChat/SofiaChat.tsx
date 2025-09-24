'use client';
import SofiaChatShell from './SofiaChatShell';

export default function SofiaChat({ agent = 'mu' }: { agent?: string }) {
  return <SofiaChatShell agent={agent} />;
}
