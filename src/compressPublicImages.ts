import fs from 'fs';
import path from 'path';
import tinify from 'tinify';

// ここに直接APIキーを埋め込む
tinify.key = 'sg316LbSHDdp8pGGNxBwBgw6J7Gwn4Xx';

const folderPath = './public';

const compressImages = async (folder: string) => {
  const files = fs.readdirSync(folder);

  for (const file of files) {
    const fullPath = path.join(folder, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      await compressImages(fullPath);
    } else if (/\.(png|jpe?g)$/i.test(file)) {
      try {
        console.log(`📦 圧縮中: ${file}`);
        const source = tinify.fromFile(fullPath);
        await source.toFile(fullPath);
        console.log(`✅ 完了: ${file}`);
      } catch (err) {
        console.error(`❌ 失敗: ${file}`, err);
      }
    }
  }
};

compressImages(folderPath).then(() => {
  console.log('\n🎉 全ファイル圧縮完了！');
});
