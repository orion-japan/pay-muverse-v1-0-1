import { redirect } from 'next/navigation';

export default async function Page({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  redirect(`/chat?open=${encodeURIComponent(threadId)}`);
}
