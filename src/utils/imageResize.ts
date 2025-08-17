// src/utils/imageResize.ts
export async function resizeImage(file: File, maxSize: number = 256): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
  
      reader.onload = (e) => {
        if (!e.target?.result) return reject("画像の読み込みに失敗しました");
        img.src = e.target.result as string;
      };
  
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject("Canvas生成失敗");
  
        const size = Math.min(img.width, img.height);
        canvas.width = maxSize;
        canvas.height = maxSize;
  
        ctx.drawImage(
          img,
          (img.width - size) / 2,
          (img.height - size) / 2,
          size,
          size,
          0,
          0,
          maxSize,
          maxSize
        );
  
        canvas.toBlob((blob) => {
          if (!blob) return reject("Blob変換失敗");
          resolve(blob);
        }, 'image/png');
      };
  
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    });
  }
  