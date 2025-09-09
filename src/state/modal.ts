// src/state/modal.ts
import { create } from 'zustand';

type ModalType = 'album' | 'picker' | 'edit' | null;

type ModalState = {
  open: ModalType;
  setOpen: (m: ModalType) => void;
};

export const useModalState = create<ModalState>((set) => ({
  open: null,
  setOpen: (m) => set({ open: m }),
}));
