// src/app/intention-prompt/gallery/page.tsx
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default function LegacyGalleryRedirect() {
  redirect('/intention-gallery');
}
