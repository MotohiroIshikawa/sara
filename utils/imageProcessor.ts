import sharp from "sharp";

export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
  resized: boolean;
}

export interface ImageProcessOptions {
  maxBytes?: number;       // 目標サイズ（既定: 4MB）
  maxWidth?: number;       // 最大幅（既定: 4096）
  maxHeight?: number;      // 最大高さ（既定: 4096）
}

// Azure Bing / Vision制限に合わせた画像リサイズ・圧縮処理
// JPEG/PNG/WEBP/HEIC/HEIF対応
export async function compressIfNeeded(
  input: Buffer,
  contentType: string,
  opts: ImageProcessOptions = {}
): Promise<ProcessedImage> {
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024; // 4MB
  const maxWidth = opts.maxWidth ?? 4096;
  const maxHeight = opts.maxHeight ?? 4096;

  // サイズが既に十分小さければスキップ
  if (input.length <= maxBytes) {
    return { buffer: input, contentType, resized: false };
  }

  try {
    const image = sharp(input, { failOnError: false });
    const meta = await image.metadata();

    const width = meta.width ?? maxWidth;
    const height = meta.height ?? maxHeight;

    const sizeTooLarge = input.length > maxBytes;
    const dimTooLarge = width > maxWidth || height > maxHeight;
    if (!sizeTooLarge && !dimTooLarge) {
      return { buffer: input, contentType, resized: false };
    }

    const scaleW = width > maxWidth ? maxWidth / width : 1;
    const scaleH = height > maxHeight ? maxHeight / height : 1;
    const scale = Math.min(scaleW, scaleH);

    const targetW = Math.floor(width * scale);
    const targetH = Math.floor(height * scale);

    // 出力形式はJPEG or WEBP推奨
    const format =
      contentType.includes("webp") ? "webp"
      : "jpeg";
    
    const resized = image.resize(targetW, targetH, { fit: "inside" });

    let buf = await resized
      [format]({ quality: 80 })
      .toBuffer();

    // 再圧縮してもまだ大きい場合は品質を下げる
    let quality = 80;
    while (buf.length > maxBytes && quality > 30) {
      quality -= 10;
      buf = await resized[format]({ quality }).toBuffer();
    }

    const newType =
      format === "jpeg" ? "image/jpeg"
      : format === "webp" ? "image/webp"
      : contentType;

    return { buffer: buf, contentType: newType, resized: true };
  } catch (err) {
    console.warn("[imageProcessor] compressIfNeeded failed, fallback to original:", err);
    return { buffer: input, contentType, resized: false };
  }
}
