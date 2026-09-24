import sharp from "sharp";

interface GridLayoutResult {
  cols: number;
  rows: number;
  totalCells: number;
  placeholderCount: number;
}

/**
 * 计算宫格布局
 * 1张: 1x1
 * 2张: 2x1
 * 3张: 3x1
 * 4张: 2x2
 * 5-9张: 3x3
 * 10-12张: 3x4
 * 13-15张: 3x5
 * ...以此类推（3列，行数递增）
 */
function calculateGridLayout(count: number): GridLayoutResult {
  let cols: number;
  let rows: number;
  if (count <= 0) {
    cols = 1;
    rows = 1;
  } else if (count === 1) {
    cols = 1;
    rows = 1;
  } else if (count === 2) {
    cols = 2;
    rows = 1;
  } else if (count === 3) {
    cols = 3;
    rows = 1;
  } else if (count === 4) {
    cols = 2;
    rows = 2;
  } else if (count <= 9) {
    // 5-9格统一用3x3
    cols = 3;
    rows = 3;
  } else {
    cols = 3;
    rows = Math.ceil(count / 3);
  }
  const totalCells = cols * rows;
  const placeholderCount = totalCells - count;
  return { cols, rows, totalCells, placeholderCount };
}

/**
 * 分割宫格图片
 * @param image - 输入的宫格图片 Buffer
 * @param length - 实际需要的图片数量（不包含占位图）
 * @returns 分割后的单张图片 Buffer 数组
 */
export default async (image: Buffer, length: number): Promise<Buffer[]> => {
  const metadata = await sharp(image).metadata();
  const { width: totalWidth, height: totalHeight } = metadata;

  if (!totalWidth || !totalHeight) {
    throw new Error("无法获取图片尺寸");
  }

  const { cols, rows } = calculateGridLayout(length);

  const cellWidth = Math.floor(totalWidth / cols);
  const cellHeight = Math.floor(totalHeight / rows);

  const buffers: Buffer[] = [];

  for (let i = 0; i < length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;

    const left = col * cellWidth;
    const top = row * cellHeight;

    const cellBuffer = await sharp(image)
      .extract({
        left,
        top,
        width: cellWidth,
        height: cellHeight,
      })
      .png()
      .toBuffer();

    buffers.push(cellBuffer);
  }

  return buffers;
};
