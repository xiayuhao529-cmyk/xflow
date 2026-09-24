import sharp from "sharp";
import "../type";
import FormData from "form-data";

export async function buildReqBody(input: VideoConfig, config: AIConfig) {
  const sizeMap: Record<string, string> = {
    "16:9": "1280x720",
    "9:16": "720x1280",
  };
  const formData = new FormData();
  formData.append("model", config.model!);
  formData.append("prompt", input.prompt);
  formData.append("seconds", String(input.duration));

  const size = sizeMap[input.aspectRatio] || "1280x720";
  formData.append("size", size);
  if (input.imageBase64 && input.imageBase64.length) {
    const base64Data = input.imageBase64[0]!.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    // 解析尺寸
    const [width, height] = size.split("x").map(Number);

    // 使用 sharp 调整图片尺寸
    const resizedBuffer = await sharp(buffer).resize(width, height, { fit: "cover" }).jpeg({ quality: 100 }).toBuffer();

    formData.append("input_reference", resizedBuffer, { filename: "image.jpg", contentType: "image/jpeg" });
  }

  return formData;
}

export function buildReqUrl(baseUrl: string): { requestUrl: string; queryUrl: string; downLoadUrl: string } {
  return {
    requestUrl: `${baseUrl}/v1/videos`,
    queryUrl: `${baseUrl}/v1/videos/{id}`,
    downLoadUrl: `${baseUrl}/v1/videos/{id}/content`,
  };
}
