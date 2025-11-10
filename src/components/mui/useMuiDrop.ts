// src/components/mui/useMuiDrop.ts
import { useRef, useState, useCallback } from 'react';

export type UseMuiDropReturn = {
  files: File[];
  urls: string[];
  dragScreen: boolean;
  fileRef: React.RefObject<HTMLInputElement>; // ← 非nullで固定
  addFiles: (fs: FileList | File[] | null | undefined) => void;
  onPick: () => void;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  setDragScreen: (v: boolean) => void;
};

export function useMuiDrop(): UseMuiDropReturn {
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [dragScreen, setDragScreen] = useState(false);

  // 非null型に合わせるため、初期値は non-null アサーションで通す
  // （実使用は ?. で守るので実害なし）
  const fileRef = useRef<HTMLInputElement>(null!);

  const addFiles = useCallback((fs: FileList | File[] | null | undefined) => {
    if (!fs) return;
    const arr = Array.from(fs as ArrayLike<File>);
    setFiles(arr);
    setUrls(arr.map((f) => URL.createObjectURL(f)));
  }, []);

  const onPick = useCallback(() => {
    fileRef.current?.click();
  }, []);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(e.target.files);
      // 再選択できるように value をクリア（任意）
      if (e.target) e.target.value = '';
    },
    [addFiles],
  );

  return { files, urls, dragScreen, fileRef, addFiles, onPick, onFileChange, setDragScreen };
}
