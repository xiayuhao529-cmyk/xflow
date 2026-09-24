import "../type";

export function buildReqBody(input: ImageConfig, config: AIConfig) {
  const size = input.size === "1K" ? "2K" : input.size;
  const sizeMap: Record<string, Record<string, string>> = {
    "16:9": {
      "2K": "2848x1600",
      "4K": "4096x2304",
    },
    "9:16": {
      "2K": "1600x2848",
      "4K": "2304x4096",
    },
  };
  const fullPrompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;

  const requestBody: Record<string, any> = {
    model: config.model,
    prompt: fullPrompt,
    size: sizeMap[input.aspectRatio][size],
    response_format: "url",
    sequential_image_generation: "disabled",
    stream: false,
    watermark: false,
    ...(input.imageBase64 && { image: input.imageBase64 }),
  };

  return requestBody;
}

export function buildReqUrl(baseUrl: string) {
  return {
    requestUrl: `${baseUrl}/v1/images/generations`,
  };
}
