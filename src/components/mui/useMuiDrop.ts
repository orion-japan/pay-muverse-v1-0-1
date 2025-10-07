// src/components/mui/useMuiDrop.ts
import { useRef, useState, useCallback } from 'react';

export type UseMuiDropReturn = {
  files: File[];
  urls: string[];
  dragScreen: boolean;
  fileRef: React.RefObject<HTMLInputElement>;
  addFiles: (fs: FileList | File[] | null | undefined) => void;
  onPick: () => void;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  setDragScreen: (v: boolean) => void;
};

export function useMuiDrop(): UseMuiDropReturn {
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [dragScreen, setDragScreen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((fs: FileList | File[] | null | undefined) => {
    if (!fs) return;
    const arr = Array.from(fs);
    setFiles(arr);
    setUrls(arr.map((f) => URL.createObjectURL(f)));
  }, []);

  const onPick = useCallback(() => {
    fileRef.current?.click();
  }, []);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(e.target.files);
    },
    [addFiles]
  );

  return { files, urls, dragScreen, fileRef, addFiles, onPick, onFileChange, setDragScreen };
}
