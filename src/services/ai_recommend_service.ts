export interface AIChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface AIChatResponse {
  response: string;
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

const DEFAULT_MODELS = [
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  '@cf/mistral/mistral-7b-instruct-v0.1',
];

export class AIRecommendService {
  private ai: any;

  constructor(aiBinding: any) {
    this.ai = aiBinding;
  }

  async chat(request: AIChatRequest, defaultModel: string): Promise<AIChatResponse> {
    const model = request.model || defaultModel || DEFAULT_MODELS[0];

    if (!this.ai) {
      throw new Error('AI binding 未配置，请在 wrangler.toml 中添加 ai binding');
    }

    try {
      const result = await this.ai.run(model, {
        messages: request.messages,
        max_tokens: request.max_tokens || 1024,
        temperature: request.temperature || 0.7,
      });

      console.log('[AI] Raw result:', JSON.stringify(result));

      const response = result.response ||
                       result.generated_text ||
                       result.output ||
                       result.text ||
                       (Array.isArray(result.choices) && result.choices[0]?.message?.content) ||
                       '';

      return {
        response,
        model,
        usage: result.usage ? {
          input_tokens: result.usage.input_tokens || 0,
          output_tokens: result.usage.output_tokens || 0,
          total_tokens: (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
        } : undefined,
      };
    } catch (error: any) {
      console.error('[AI] 调用失败:', error.message);

      if (error.message?.includes('not found') || error.message?.includes('Model')) {
        throw new Error(`模型 ${model} 不存在或暂未上线，请检查模型名称`);
      }

      throw new Error(`AI 服务调用失败: ${error.message}`);
    }
  }

  getAvailableModels(): string[] {
    return [...DEFAULT_MODELS];
  }

  validateModel(model: string): boolean {
    return DEFAULT_MODELS.includes(model) || model.startsWith('@cf/');
  }
}
