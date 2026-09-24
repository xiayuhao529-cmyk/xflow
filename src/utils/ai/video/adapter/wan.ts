import "../type";

export function buildReqBody(input: VideoConfig, config: AIConfig) {
  const images = input.imageBase64 || [];

  // 构建图片内容
  const imageContent = images.map((base64, index) => {
    const item: Record<string, any> = {
      type: "image_url",
      image: { url: base64 },
    };
    return item;
  });
  const sizeMap: Record<string, Record<string, string>> = {
    "480p": {
      "16:9": "832*480",
      "9:16": "480*832",
    },
    "720p": {
      "16:9": "1280*720",
      "9:16": "720*1280",
    },
    "1080p": {
      "16:9": "1920*1080",
      "9:16": "1080*1920",
    },
  };
  const hasStartEnd = input.mode == "startEnd";

  const imageReq: Record<string, string> = {};
  if (hasStartEnd && Array.isArray(images) && images.length) {
    if (images[0]) imageReq.first_frame_url = images[0];
    if (images[1]) imageReq.last_frame_url = images[1];
  } else if (!hasStartEnd && Array.isArray(images) && images[0]) {
    imageReq.img_url = images[0];
  }

  const resolutionKey = input.resolution;

  const size = sizeMap[resolutionKey]?.[input.aspectRatio];

  const requestBody: any = {
    model: config.model,
    ...(imageReq?.img_url ? { input_reference: imageReq.img_url } : {}),
    prompt: input.prompt,
    size,
    duration: input.duration,
    metadata: {
      ...imageReq,
      audio: input?.audio ?? false,
    },
  };
  return requestBody;
}

export function buildReqUrl(baseUrl: string): { requestUrl: string; queryUrl: string } {
  return {
    requestUrl: `${baseUrl}/v1/video/generations`,
    queryUrl: `${baseUrl}/v1/video/generations/{id}`,
  };
}
