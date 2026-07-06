/**
 * modules/image.js
 * 圖片上傳的壓縮工具：所有上傳都先壓縮再存進 IndexedDB,避免資料庫肥大。
 * - 頭像：置中裁成正方形，縮至 128×128,約 10~20KB
 * - 背景：等比縮至最長邊 800px,約 60~150KB
 */

/** 讀取檔案為 <img> 元素。 */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('請選擇圖片檔案'));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片讀取失敗')); };
    img.src = url;
  });
}

/** 頭像：置中方形裁切 + 縮放 + JPEG 壓縮，回傳 dataURL。 */
export async function compressAvatar(file, size = 128) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.82);
}

/** 背景：等比縮至最長邊 maxSide + JPEG 壓縮，回傳 dataURL。 */
export async function compressBackground(file, maxSide = 800) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.8);
}

/** 訊息/貼文照片：等比縮至最長邊 1024 + JPEG 壓縮，回傳 dataURL。 */
export async function compressPhoto(file, maxSide = 1024) {
  return compressBackground(file, maxSide);
}
