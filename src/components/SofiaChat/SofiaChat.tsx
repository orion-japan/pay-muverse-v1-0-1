'use client';
import SofiaChatShell from './SofiaChatShell';

export default function SofiaChat({
  agent = 'mu',
  open,
}: {
  agent?: string;
  open?: string;
}) {
  return <SofiaChatShell agent={agent} open={open} />;
}
