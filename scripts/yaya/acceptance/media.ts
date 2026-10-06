import sharp from "sharp";

/**
 * 合成验收图片（sharp 现成依赖，不新增任何依赖）。
 *
 * 全部为几何图形合成，不含任何真实幼儿影像；DB 侧再以 metadata.synthetic=true
 * 与 source_kind 记录合成来源。图片字节确定性生成，便于回读校验 checksum。
 */
export async function syntheticSharedPhoto(): Promise<Buffer> {
  const width = 320;
  const height = 200;
  const base = await sharp({
    create: { width, height, channels: 3, background: { r: 246, g: 240, b: 224 } },
  })
    .png()
    .toBuffer();
  const band = await sharp({
    create: { width: width - 40, height: 60, channels: 3, background: { r: 46, g: 116, b: 181 } },
  })
    .png()
    .toBuffer();
  const dot = await sharp({
    create: { width: 60, height: 60, channels: 3, background: { r: 192, g: 80, b: 77 } },
  })
    .png()
    .toBuffer();
  return sharp(base)
    .composite([
      { input: band, left: 20, top: 30 },
      { input: dot, left: 220, top: 110 },
    ])
    .png()
    .toBuffer();
}
