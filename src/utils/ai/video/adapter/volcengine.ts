import "../type";

export function buildReqBody(input: VideoConfig, config: AIConfig) {
  const hasStartEndType = input.mode === "startEnd";
  const images = input.imageBase64 || [];
  // 判断是否为首尾帧模式（需要两张图且类型支持首尾帧）
  const isStartEndMode = images.length === 2 && hasStartEndType;

  // 构建图片内容
  const imageContent = images.map((base64, index) => {
    const item: Record<string, any> = {
      type: "image_url",
      image_url: { url: base64 },
    };
    if (isStartEndMode) {
      item.role = index === 0 ? "first_frame" : "last_frame";
    }
    return item;
  });

  // // 构建请求体
  // const requestBody: Record<string, any> = {
  //   model: config.model,
  //   content: [{ type: "text", text: input.prompt }, ...imageContent],
  //   duration: input.duration,
  //   resolution: input.resolution,
  //   watermark: false,
  // };
  const requestBody: any = {
    model: config.model,
    ...(input.imageBase64 && input.imageBase64.length ? { images: input.imageBase64 } : {}),
    prompt: input.prompt,
    duration: input.duration,
    size: input.resolution,
    metadata: {
      generate_audio: input?.audio ?? false,
      ratio: input.aspectRatio,
      image_roles: ["first_frame", "last_frame"],
    },
  };

  // // 仅当模型支持音频时才添加 generate_audio 字段
  // if (typeof input.audio == "boolean") {
  //   requestBody.generate_audio = input.audio ?? false;
  // }
  return requestBody;
}

export function buildReqUrl(baseUrl: string): { requestUrl: string; queryUrl: string } {
  return {
    requestUrl: `${baseUrl}/v1/video/generations`,
    queryUrl: `${baseUrl}/v1/video/generations/{id}`,
  };
}
