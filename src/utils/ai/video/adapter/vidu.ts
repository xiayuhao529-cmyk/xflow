import "../type";

export function buildReqBody(input: VideoConfig, config: AIConfig) {
  const requestBody: any = {
    model: config.model,
    ...(input.imageBase64 && input.imageBase64.length ? { images: input.imageBase64 } : {}),
    prompt: input.prompt,
    duration: input.duration,
    size: input.resolution,
    metadata: {
      aspect_ratio: input.aspectRatio,
      audio: input?.audio ?? false,
      off_peak: false,
    },
  };

    console.log("%c Line:5 🍔 requestBody", "background:#465975", requestBody);
  return requestBody;
}

export function buildReqUrl(baseUrl: string): { requestUrl: string; queryUrl: string } {
  return {
    requestUrl: `${baseUrl}/v1/video/generations`,
    queryUrl: `${baseUrl}/v1/video/generations/{id}`,
  };
}
