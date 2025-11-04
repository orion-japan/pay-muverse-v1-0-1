'use client';

// next/link の default / named どちらでも動く互換レイヤー
import * as NextLink from 'next/link';
const LinkAny: any = (NextLink as any).default ?? (NextLink as any).Link;

export const Link = LinkAny;
export default LinkAny;
