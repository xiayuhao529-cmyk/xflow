import "../type";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, ModelMessage } from "ai";

export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");
  if (!input.prompt) throw new Error("缺少提示词");
  
  const options: any = {};
  if (config.apiKey) options.apiKey = config.apiKey;
  if (config?.baseURL) options.baseURL = config.baseURL;
  const google = createGoogleGenerativeAI({
    ...options,
  });

  // 构建完整的提示词
  const fullPrompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
  let promptData: ModelMessage[] | string = [];
  if (input.imageBase64 && input.imageBase64.length) {
    promptData = [{ role: "system", content: fullPrompt + `请直接输出图片` }];
    promptData.push({
      role: "user",
      content: input.imageBase64.map((i) => ({
        type: "image",
        image: i,
      })),
    });
  } else {
    promptData = fullPrompt + `\n请直接输出图片`;
  }

  const result = await generateText({
    model: google.languageModel(config.model),
    prompt: promptData,
    providerOptions: {
      google: {
        imageConfig: {
          ...(config.model == "gemini-2.5-flash-image"
            ? { aspectRatio: input.aspectRatio }
            : { aspectRatio: input.aspectRatio, imageSize: input.size }),
        },
      },
    },
  });

  if (!result.files.length) {
    console.error(JSON.stringify(result.response, null, 2));
    throw new Error("图片生成失败");
  }
  let imageBase64;
  for (const item of result.files) {
    imageBase64 = `data:${item.mediaType};base64,${item.base64}`;
  }
  // 返回生成的图片 base64
  return imageBase64!;
};
