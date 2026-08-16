const MAX_DIMENSION = 2000;

/**
 * 撮影直後のカメラ写真は、EXIFの向き情報(Orientation)によって実際の見た目が
 * 決まるだけで、生のピクセルデータ自体は横倒しのまま保存されていることが多い
 * (特にレシートのような縦長の紙を横に構えて撮った場合)。ブラウザは表示時に
 * このタグを見て自動回転するが、S3にアップロードしてBedrockのvision APIに
 * 生バイトを渡すと、EXIFタグは見てもらえず本当に横倒しの画像として読まれてしまい、
 * OCR精度が大きく落ちる原因になっていた(2026-08-16 実機のS3画像を直接確認して特定)。
 *
 * `createImageBitmap`の`imageOrientation: 'from-image'`はEXIFの向きを実際に
 * ピクセルへ焼き込んでデコードしてくれるため、それをcanvasに描き直すことで
 * 「向きが補正済みの画像」を作り、アップロード前に差し替える。ついでに大きすぎる
 * 画像(iPhoneのフル解像度は4000px超)を縮小し、アップロード/推論コストも減らす。
 */
export async function normalizeReceiptPhoto(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // createImageBitmapやEXIF向き補正に対応していない環境では、元のファイルをそのまま使う
    return file;
  }

  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;

  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) return file;

  return new File([blob], 'receipt.jpg', { type: 'image/jpeg' });
}
