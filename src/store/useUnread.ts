// 'use client';
import { create } from 'zustand';

type UnreadState = {
  talkUnread: number;
  updatedAt?: number;
  setTalkUnread: (n: number) => void;
  resetTalkUnread: () => void;
};

export const useUnread = create<UnreadState>((set) => ({
  talkUnread: 0,
  updatedAt: undefined,
  setTalkUnread: (n: number) =>
    set({
      talkUnread: Math.max(0, Number.isFinite(n) ? Math.round(n) : 0),
      updatedAt: Date.now(),
    }),
  resetTalkUnread: () => set({ talkUnread: 0, updatedAt: Date.now() }),
}));
