interface ImageConfig {
  systemPrompt?: string;
  prompt: string;
  imageBase64: string[];
  size: "1K" | "2K" | "4K";
  aspectRatio: string;
  resType?: "url" | "b64";
  taskClass: string;
  name: string;
  describe: string;
  projectId: number;
}

interface AIConfig {
  model?: string;
  apiKey?: string;
  baseURL?: string;
}