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
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast',  // 🔑 非思考模型，JSON输出更稳定
  '@cf/qwen/qwen3-30b-a3b-fp8',               // 思考模型，max_tokens需更大
  '@cf/mistral/mistral-7b-instruct-v0.1',
];

export interface SeedSong {
  name: string;
  singer: string;
  album?: string;
}

export interface CandidateSong {
  index: number;
  name: string;
  singer: string;
  albumName: string;
  source: string;
  id: string;
  songmid?: string;
  hash?: string;
  img?: string;
  interval?: string;
}

export interface RankedSong {
  index: number;
  reason: string;
  category: string;
}

export interface RankResult {
  songs: RankedSong[];
  method: 'ai' | 'keyword_fallback';
  error?: string;
  aiResponseLength?: number;
  aiResponsePreview?: string;
}

export interface UserPreferences {
  scene?: string;      // 场景: 开车提神/深夜助眠/运动健身/工作学习/聚会派对/独处放空/情绪低落/兴奋High
  explore?: string;    // 探索: strict/moderate/surprise
  era?: string;        // 年代: any/classic/millennium/2010s/latest
  language?: string;   // 语言: any/chinese/western/japanese_korean/mixed
  customPrompt?: string; // 自定义需求
}

// 场景对应的搜索关键词提示
const SCENE_KEYWORDS: Record<string, string> = {
  '开车提神': '节奏快 律动感 摇滚 电子',
  '深夜助眠': '轻音乐 纯音乐 安静 舒缓',
  '运动健身': '高能量 燃 电子 DJ 嘻哈',
  '工作学习': '轻柔 无歌词 背景 Lo-fi 古典',
  '聚会派对': 'DJ 舞曲 电子 House 气氛',
  '独处放空': '氛围感 民谣 爵士 独立音乐',
  '情绪低落': '治愈 温暖 舒缓 共情',
  '兴奋High': '电子 摇滚 金属 爆发力',
};

// 年代对应的搜索关键词提示
const ERA_KEYWORDS: Record<string, string> = {
  'classic': '经典 老歌 90年代',
  'millennium': '2000年 千禧 金曲',
  '2010s': '2010 2015 流行',
  'latest': '2023 2024 新歌 最新',
};

// 语言对应的搜索关键词提示
const LANG_KEYWORDS: Record<string, string> = {
  'chinese': '华语 中文',
  'western': '英文 欧美',
  'japanese_korean': '日语 韩语 日韩',
  'mixed': '华语+英文+日韩（多语言混合，每组关键词只用一种语言）',
};

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

  // ═════════════════════════════════════════════════════════════
  // 构建偏好关键词（从场景/年代/语言映射）
  // ═════════════════════════════════════════════════════════════
  private buildPreferenceHints(prefs?: UserPreferences): string {
    if (!prefs) return '';
    const parts: string[] = [];

    if (prefs.scene && SCENE_KEYWORDS[prefs.scene]) {
      parts.push(`场景偏好: ${SCENE_KEYWORDS[prefs.scene]}`);
    }
    if (prefs.era && prefs.era !== 'any' && ERA_KEYWORDS[prefs.era]) {
      parts.push(`年代偏好: ${ERA_KEYWORDS[prefs.era]}`);
    }
    if (prefs.language && prefs.language !== 'any' && LANG_KEYWORDS[prefs.language]) {
      parts.push(`语言偏好: ${LANG_KEYWORDS[prefs.language]}`);
    }
    if (prefs.explore) {
      const exploreMap: Record<string, string> = {
        'strict': '严格匹配用户口味',
        'moderate': '适度拓展，20%探索新风格',
        'surprise': '大胆探索，多推荐用户没接触过的风格',
      };
      if (exploreMap[prefs.explore]) parts.push(`探索程度: ${exploreMap[prefs.explore]}`);
    }
    if (prefs.customPrompt && prefs.customPrompt.trim()) {
      parts.push(`用户自定义需求: ${prefs.customPrompt.trim()}`);
    }

    return parts.length > 0 ? `\n【用户偏好】\n${parts.join('\n')}\n` : '';
  }

  // ═════════════════════════════════════════════════════════════
  // Stage 2: AI 生成搜索关键词（三模式：customPrompt > preferences > seeds）
  // ═════════════════════════════════════════════════════════════
  async generateSearchKeywords(
    seeds: SeedSong[],
    hotSearchKeywords: string[],
    userProfile: any,
    preferences: UserPreferences | undefined,
    defaultModel: string
  ): Promise<string[]> {
    const model = defaultModel || DEFAULT_MODELS[0];

    const seedList = seeds.map((s, i) => `${i + 1}. 《${s.name}》- ${s.singer}`).join('\n');

    // 🔑 判断三种模式
    const hasCustomPrompt = preferences?.customPrompt && preferences.customPrompt.trim().length > 0;
    const hasSceneOrLang = preferences?.scene || (preferences?.era && preferences.era !== 'any') || (preferences?.language && preferences.language !== 'any');
    const isEmptySeeds = seeds.length === 0;
    const mode: 'A' | 'B' | 'C' | 'D' = hasCustomPrompt ? 'A' : (hasSceneOrLang ? 'B' : (isEmptySeeds ? 'D' : 'C'));

    console.log(`[AI] generateSearchKeywords 模式=${mode} (A=自定义需求, B=偏好驱动, C=种子驱动, D=新用户探索)`);

    // 🔑 通用：avoidDirections + 不喜欢歌曲特征
    const avoidStr = userProfile?.avoidDirections
      ? (Array.isArray(userProfile.avoidDirections) ? userProfile.avoidDirections.join('、') : String(userProfile.avoidDirections))
      : '';
    const dislikeArtists = (preferences as any)?.dislikeArtists as string[] || [];

    let prompt: string;

    if (mode === 'A') {
      // ═══════════════════════════════════════
      // 模式A：有 customPrompt（用户意图最明确）
      // 关键词围绕 customPrompt 生成，热搜参考不超过20%（最多4组）
      // ═══════════════════════════════════════
      const customText = preferences!.customPrompt!.trim();
      const hotListA = hotSearchKeywords.slice(0, 10).join(', ');
      prompt = `根据用户的个性化需求，生成20组音乐搜索关键词。

【用户的需求】
${customText}

【用户口味参考（仅供参考方向，不要直接用歌手名搜索）】
${seedList}

【当前热搜趋势（仅参考，最多4组来自热搜）】
${hotListA}

${avoidStr ? `【需避免的风格方向】\n${avoidStr}\n` : ''}
${dislikeArtists.length > 0 ? `【用户不喜欢的歌曲特征参考】\n${dislikeArtists.slice(0, 8).join('、')}\n` : ''}
【要求 - 非常重要】
1. 全部20组关键词都必须与用户需求"${customText}"直接相关！
2. 理解用户意图和情绪，不是字面搜索：
   - 例如"今天生日"→"欢快流行"、"庆生派对"、"快乐节奏"、"生日歌曲"、"庆祝英文歌"、"派对舞曲"
   - 例如"想听DJ"→"DJ舞曲"、"电子嗨曲"、"节拍强劲"、"house音乐"、"edm电子"、"舞曲remix"
   - 例如"失恋了"→"伤感情歌"、"心碎流行"、"治愈英文歌"、"失恋歌曲"、"emo摇滚"、"悲伤民谣"
3. 每组2-8个字，必须是QQ音乐/网易云能搜到歌曲的词
4. ❌ 不要生成和需求无关的词！
5. ❌ 不要生成纯歌手名搜索（如"马思唯"），要生成风格/场景/流派词
6. 🔑 热搜参考限制：最多4组（20%）可以参考热搜趋势，其余16组必须围绕用户需求生成
${avoidStr ? `7. ❌ 不要生成与以下方向相关的关键词：${avoidStr}` : ''}

【输出格式】
只输出JSON数组：
["关键词1","关键词2",..."关键词20"]`;

    } else if (mode === 'B') {
      // ═══════════════════════════════════════
      // 模式B：有 scene/explore/era/language（用户意图明确）
      // 方向优先，偏好打底：选择的偏好绝对覆盖平时习惯
      // ═══════════════════════════════════════
      const sceneKw = preferences?.scene && SCENE_KEYWORDS[preferences.scene] ? SCENE_KEYWORDS[preferences.scene] : '';
      const eraKw = preferences?.era && preferences.era !== 'any' && ERA_KEYWORDS[preferences.era] ? ERA_KEYWORDS[preferences.era] : '';
      const langKw = preferences?.language && preferences.language !== 'any' && LANG_KEYWORDS[preferences.language] ? LANG_KEYWORDS[preferences.language] : '';
      const exploreMode = preferences?.explore || 'moderate';

      // 构建画像信息（作为"打底"参考）
      const profileParts: string[] = [];
      if (userProfile?.profileName) profileParts.push(`画像: ${userProfile.profileName}`);
      if (userProfile?.musicStyles?.length) profileParts.push(`平时偏好流派: ${Array.isArray(userProfile.musicStyles) ? userProfile.musicStyles.join('、') : userProfile.musicStyles}`);
      if (userProfile?.languagePreference) profileParts.push(`平时语言偏好: ${userProfile.languagePreference}`);
      if (userProfile?.emotionTone) profileParts.push(`平时情绪基调: ${userProfile.emotionTone}`);
      if (userProfile?.rhythmPreference) profileParts.push(`平时节奏偏好: ${userProfile.rhythmPreference}`);
      const profileStr = profileParts.length > 0 ? profileParts.join('\n') : '无';

      const prefDescParts: string[] = [];
      if (preferences?.scene) prefDescParts.push(`场景: ${preferences.scene}${sceneKw ? ` (${sceneKw})` : ''}`);
      if (eraKw) prefDescParts.push(`年代: ${preferences.era} (${eraKw})`);
      if (langKw) prefDescParts.push(`语言: ${preferences.language} (${langKw})`);
      if (exploreMode) {
        const exploreDesc: Record<string, string> = { 'strict': '严格匹配口味', 'moderate': '适度探索', 'surprise': '大胆探索新风格' };
        prefDescParts.push(`探索: ${exploreDesc[exploreMode] || exploreMode}`);
      }

      // 🔑 构建明确的覆盖指令
      const overrideWarnings: string[] = [];
      if (langKw) {
        overrideWarnings.push(`- 语言覆盖：用户选择了"${langKw}"，全部关键词必须偏向该语言方向。即使用户平时主要听华语，也不要生成华语相关关键词！`);
      }
      if (preferences?.scene) {
        overrideWarnings.push(`- 场景覆盖：用户选择了"${preferences.scene}"，全部关键词必须体现该场景的氛围。即使用户平时听柔和的歌，选了"兴奋High"就生成高能量关键词，不要生成柔和的！`);
      }
      if (eraKw) {
        overrideWarnings.push(`- 年代覆盖：用户选择了"${eraKw}"，全部关键词必须体现该年代特征。即使用户平时听新歌，选了经典就只生成经典老歌方向的关键词！`);
      }

      prompt = `根据用户选择的明确方向，生成20组音乐搜索关键词。

【用户选择的方向（绝对优先，覆盖平时习惯）】
${prefDescParts.join('\n')}

【用户平时口味（仅用于未选择方向的空缺补充）】
${profileStr}
种子歌曲: ${seeds.map(s => `${s.name}-${s.singer}`).slice(0, 5).join(', ')}

${avoidStr ? `【硬约束 - 不可违反】\n需避免的风格方向: ${avoidStr}\n` : ''}
${dislikeArtists.length > 0 ? `【用户不喜欢的歌曲特征参考】\n${dislikeArtists.slice(0, 8).join('、')}\n` : ''}
【核心规则 - 方向优先，偏好打底】
1. 用户选择的每一个方向（场景/语言/年代）都是绝对优先级，必须同时体现在关键词中！
   - 不要只侧重某一个方向，所有选择的方向必须同时贯穿
   - 例如：scene=情绪低落 + era=classic + language=chinese → 关键词应该是"经典华语疗伤"、"90年代华语治愈"、"怀旧华语情歌"等，同时包含场景+年代+语言
${overrideWarnings.join('\n')}
2. 用户平时的画像偏好只用于补充用户【没有明确选择】的维度
3. 每组2-8个字，必须是QQ音乐/网易云能搜到歌曲的词
4. 关键词类型（每组都必须同时体现场景+年代+语言）：
   - 2组：场景+年代组合词，如"90年代治愈"、"经典疗伤金曲"
   - 2组：年代+语言组合词，如"经典华语老歌"、"90年代中文流行"
   - 2组：场景+语言+年代组合词，如"怀旧华语抒情"、"经典中文疗伤"
${preferences?.language === 'mixed' ? `5. 🔑 语言=多语混合：20组关键词必须覆盖不同语言！\n   - 7组用华语词\n   - 7组用英文词\n   - 6组用日韩词\n   - ❌ 绝对不要用"多语"这个词！每组关键词只能是单一语言的！` : ''}
${exploreMode === 'surprise' ? `${preferences?.language === 'mixed' ? '6' : '5'}. 🔑 探索模式=惊喜：大胆生成用户平时不怎么听的方向，但必须符合用户选择的方向！\n` : ''}${exploreMode === 'strict' ? `${preferences?.language === 'mixed' ? '6' : '5'}. 探索模式=严格：在用户选择的方向内，尽量贴近用户平时的口味\n` : ''}
6. ❌ 不要生成纯歌手名搜索，要生成风格/场景/流派词
${avoidStr ? `7. ❌ 不要生成与以下方向相关的关键词：${avoidStr}` : ''}

【输出格式】
只输出JSON数组：
["关键词1","关键词2",..."关键词20"]`;

    } else if (mode === 'D') {
      // ═══════════════════════════════════════
      // 模式D：新用户探索模式（无种子歌曲、无偏好）
      // 生成多样化关键词覆盖不同场景，探索用户喜好
      // ═══════════════════════════════════════
      const hotList = hotSearchKeywords.slice(0, 15).join(', ');

      prompt = `你是一个音乐推荐专家。这是一位新用户，还没有听过任何歌曲，没有收藏记录。
你的任务是生成20组【多样化】的搜索关键词，覆盖不同风格和场景，帮助探索用户的音乐喜好。

【当前各平台热搜趋势】
${hotList}

【要求 - 非常重要】
1. 生成20组关键词，每组2-8个字
2. 关键词必须是音乐平台能搜到歌曲的词
3. 🔑 多样性要求：20组关键词必须覆盖不同风格方向！
   - 6组：当下热门流行（可参考热搜趋势，但不要直接用歌手名）
   - 7组：经典怀旧方向，如"经典老歌"、"90年代金曲"
   - 7组：不同风格探索（民谣、电子、摇滚、R&B、爵士等）
4. ❌ 不要全部生成同一风格的关键词
5. ❌ 不要生成纯歌手名搜索

【输出格式】
只输出JSON数组：
["关键词1","关键词2",..."关键词20"]`;

    } else {
      // ═══════════════════════════════════════
      // 模式C：纯种子+画像驱动（无明确偏好）
      // ═══════════════════════════════════════
      const profileHint = userProfile?.profileName || userProfile?.profileDesc || '';
      const hotList = hotSearchKeywords.slice(0, 10).join(', ');

      prompt = `根据用户喜欢的歌曲和画像，生成20组音乐搜索关键词。

【用户喜欢的歌曲】
${seedList}

【用户画像】
${profileHint}

【热搜趋势（参考潮流方向）】
${hotList}

${avoidStr ? `【需避免的风格方向】\n${avoidStr}\n` : ''}
${dislikeArtists.length > 0 ? `【用户不喜欢的歌曲特征参考】\n${dislikeArtists.slice(0, 8).join('、')}\n` : ''}
【要求 - 非常重要】
1. 生成20组关键词，每组2-8个字
2. 关键词必须是音乐平台能搜到歌曲的词，不要生造词
3. 关键词类型（20组要丰富多样）：
   - 7组：歌手风格词，从种子歌曲的歌手名衍生
   - 7组：流派场景词，音乐平台常用分类词
   - 6组：画像衍生词，从用户画像偏好衍生
4. ✅ 好的关键词："马思唯"、"中文说唱"、"华语抒情"
   ❌ 坏的关键词："深夜循环"、"治愈系"（平台搜不到）
${avoidStr ? `5. ❌ 不要生成与以下方向相关的关键词：${avoidStr}` : ''}

【输出格式】
只输出JSON数组：
["关键词1","关键词2",..."关键词20"]`;
    }

    try {
      const result = await this.ai.run(model, {
        messages: [
          { role: 'system', content: '你是音乐搜索关键词生成器。直接输出JSON数组，不要任何解释。不要思考过程，直接输出结果。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 2048,
        temperature: 0.6,
      });

      const rawResp = result.response ||
                       result.generated_text ||
                       result.output ||
                       result.text ||
                       (Array.isArray(result.choices) && result.choices[0]?.message?.content) ||
                       '';
      const response = typeof rawResp === 'string' ? rawResp : JSON.stringify(rawResp);

      console.log(`[AI] generateSearchKeywords 模式=${mode} 原始响应(前200字):`, response.substring(0, 200));

      let jsonStr = response.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      }

      const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      jsonStr = jsonStr.replace(/\[\(/g, '[').replace(/\)\]/g, ']');
      jsonStr = jsonStr.replace(/,\s*\]/g, ']');

      const keywords = JSON.parse(jsonStr);
      if (Array.isArray(keywords)) {
        // 🔑 后置过滤：去掉与 avoidDirections 矛盾的关键词
        let filtered = keywords.filter((k: any) => typeof k === 'string' && k.trim());
        if (avoidStr) {
          const avoidLower = avoidStr.toLowerCase();
          const beforeCount = filtered.length;
          filtered = filtered.filter((kw: string) => {
            const kwLower = kw.toLowerCase();
            const avoidWords = ['说唱', 'rap', '嘻哈', '电音', 'dj', '舞曲', '重金属', '摇滚'];
            for (const aw of avoidWords) {
              if (avoidLower.includes(aw) && kwLower.includes(aw)) {
                console.log(`[AI] 🔑 过滤矛盾关键词: "${kw}" (与avoidDirections冲突: ${aw})`);
                return false;
              }
            }
            return true;
          });
          if (filtered.length < beforeCount) {
            console.log(`[AI] 🔑 avoidDirections后置过滤: ${beforeCount} → ${filtered.length}`);
          }
        }

        // 🔑 语言后置过滤：过滤掉与用户选择语言矛盾的关键词 + 通用词（不含任何语言标记的）
        if (mode === 'B') {
          const selLang = preferences?.language;
          
          // mixed 模式：删掉含"多语"的关键词（搜索引擎不认识这个词），不删其他
          if (selLang === 'mixed') {
            const beforeCount = filtered.length;
            filtered = filtered.filter((kw: string) => {
              if (/多语|混合/.test(kw)) {
                console.log(`[AI] 🔑 mixed过滤: 移除"${kw}" (含"多语/混合"，搜索引擎不认识)`);
                return false;
              }
              return true;
            });
            if (filtered.length < beforeCount) {
              console.log(`[AI] 🔑 mixed后置过滤: ${beforeCount} → ${filtered.length}`);
            }
          }
          
          // 矛盾词：用户选了X语言，就过滤掉其他语言的关键词
          const conflictWords: Record<string, RegExp> = {
            'western': /华语|中文|国语|粤语|闽南|台语|日语|韩语|韩文|日文|J-pop|K-pop/,
            'chinese': /英文|欧美|english|western|日本|韩语|韩文|日文|J-pop|K-pop/,
            'japanese_korean': /华语|中文|国语|粤语|闽南|台语|英文|欧美|english|western/,
          };
          
          // 语言标记词：用户选了X语言，关键词必须包含对应语言标记
          const langMarkers: Record<string, RegExp> = {
            'western': /英文|欧美|english|western|欧美流行|英文歌/,
            'chinese': /华语|中文|国语|粤语|闽南|台语/,
            'japanese_korean': /日韩|日语|韩语|日文|韩文|J-pop|K-pop|日本|韩国/,
          };
          
          if (selLang && conflictWords[selLang] && langMarkers[selLang]) {
            const beforeCount = filtered.length;
            filtered = filtered.filter((kw: string) => {
              // 1. 先过滤矛盾词
              if (conflictWords[selLang].test(kw)) {
                console.log(`[AI] 🔑 语言过滤: 移除"${kw}" (含矛盾语言词)`);
                return false;
              }
              // 2. 再过滤通用词（不含任何语言标记的）
              if (!langMarkers[selLang].test(kw)) {
                console.log(`[AI] 🔑 语言过滤: 移除"${kw}" (不含${selLang}语言标记，是通用词)`);
                return false;
              }
              return true;
            });
            if (filtered.length < beforeCount) {
              console.log(`[AI] 🔑 语言后置过滤(${selLang}): ${beforeCount} → ${filtered.length}`);
            }
          }
        }

        // 🔑 AI生成20组关键词，随机抽6组用于搜索（增加每次推荐的多样性）
        const SEARCH_KEYWORD_COUNT = 6;
        if (filtered.length > SEARCH_KEYWORD_COUNT) {
          filtered = filtered.sort(() => Math.random() - 0.5).slice(0, SEARCH_KEYWORD_COUNT);
        }
        console.log(`[AI] generateSearchKeywords 最终关键词(${mode}): 20组中随机抽取${filtered.length}组:`, filtered.join(', '));
        return filtered;
      }

      throw new Error('AI返回格式不正确: ' + response.substring(0, 100));
    } catch (error: any) {
      console.error(`[AI] generateSearchKeywords(${mode}) 失败:`, error.message);
      throw new Error(`AI关键词生成失败: ${error.message}`);
    }
  }

  // ═════════════════════════════════════════════════════════════
  // Stage 5: AI 排序候选歌曲 + 生成推荐理由
  // ═════════════════════════════════════════════════════════════
  async rankCandidates(
    seeds: SeedSong[],
    candidates: CandidateSong[],
    userProfile: any,
    preferences: UserPreferences | undefined,
    defaultModel: string,
    searchKeywords: string[] = [],
    dislikeArtists: string[] = []
  ): Promise<RankResult> {
    const model = defaultModel || DEFAULT_MODELS[0];

    const seedList = seeds.map((s, i) => `${i + 1}. 《${s.name}》- ${s.singer}`).join('\n');

    // 🔑 平台轮转打散：按平台轮转取歌，确保每个平台都有代表
    const candidatesByPlatform: Map<string, typeof candidates> = new Map();
    for (const c of candidates) {
      const plat = c.source || 'unknown';
      if (!candidatesByPlatform.has(plat)) candidatesByPlatform.set(plat, []);
      candidatesByPlatform.get(plat)!.push(c);
    }
    const shuffledCandidates: typeof candidates = [];
    const platformLists = Array.from(candidatesByPlatform.values());
    let idx = 0;
    while (shuffledCandidates.length < candidates.length) {
      let added = false;
      for (const platList of platformLists) {
        if (idx < platList.length) {
          shuffledCandidates.push(platList[idx]);
          added = true;
        }
      }
      if (!added) break;
      idx++;
    }
    console.log(`[AI] rankCandidates 平台轮转: ${candidates.length}首打散为${shuffledCandidates.length}首 (平台: ${Array.from(candidatesByPlatform.keys()).join(',')})`);

    // 候选列表：最多120首，超过则随机抓取120首
    // 🔑 修复：不暴露source平台，避免AI偏向某个平台
    const MAX_CANDIDATES = 120;
    const limitedCandidates = shuffledCandidates.length > MAX_CANDIDATES
      ? shuffledCandidates.sort(() => Math.random() - 0.5).slice(0, MAX_CANDIDATES)
      : shuffledCandidates;
    const candidateList = limitedCandidates.map((c, i) =>
      `${i + 1}.《${c.name}》-${c.singer} [${c.interval || '??:??'}]`
    ).join('\n');

    const targetCount = limitedCandidates.length;
    const prefHints = this.buildPreferenceHints(preferences);

    // 🔑 简化prompt，减少输入token，提高成功率
    const hasCustom = preferences?.customPrompt && preferences.customPrompt.trim().length > 0;
    const customPromptText = hasCustom ? preferences!.customPrompt!.trim() : '';

    // 🔑 P1修复：构建完整6维画像详情
    const profileParts: string[] = [];
    if (userProfile?.profileName) profileParts.push(`画像名称: ${userProfile.profileName}`);
    if (userProfile?.profileDesc) profileParts.push(userProfile.profileDesc);
    if (userProfile?.musicStyles?.length) profileParts.push(`流派偏好: ${userProfile.musicStyles.join('、')}`);
    if (userProfile?.languagePreference) profileParts.push(`语言偏好: ${userProfile.languagePreference}`);
    if (userProfile?.emotionTone) profileParts.push(`情绪基调: ${userProfile.emotionTone}`);
    if (userProfile?.rhythmPreference) profileParts.push(`节奏偏好: ${userProfile.rhythmPreference}`);
    if (userProfile?.voicePreference) profileParts.push(`声音偏好: ${userProfile.voicePreference}`);
    if (userProfile?.eraPreference) profileParts.push(`年代偏好: ${userProfile.eraPreference}`);
    const profileDetail = profileParts.length > 0 ? profileParts.join('\n') : '';

    // 🔑 修复：构建不喜欢歌曲提示（具体歌曲，不是排除整个歌手）
    const dislikeHint = dislikeArtists.length > 0
      ? `\n【用户不喜欢的歌曲（避免推荐相似风格）】\n${dislikeArtists.join('、')}\n注意：用户只是不喜欢这些具体歌曲，不代表不喜欢这些歌手的其他作品。请分析这些歌曲的共同特征，在排序时降低相似风格歌曲的优先级。\n`
      : '';

    // 🔑 新增：avoidDirections（用户画像明确标注的需避免方向）
    const avoidHint = userProfile?.avoidDirections
      ? `\n【需避免的风格方向】\n${userProfile.avoidDirections}\n排序时优先排除符合以上特征的候选歌曲。\n`
      : '';

    // 🔑 构建场景/偏好硬性要求
    const hasScene = preferences?.scene && preferences.scene.trim().length > 0;
    const sceneName = preferences?.scene || '';
    const sceneKw = hasScene && SCENE_KEYWORDS[sceneName] ? SCENE_KEYWORDS[sceneName] : '';

    // 场景硬性过滤指令
    let sceneRequirement = '';
    if (hasScene) {
      const sceneFilters: Record<string, string> = {
        '运动健身': '🔑🔑🔑 最高优先级！必须只选适合运动的歌！运动歌的特征：BPM快(120+)、节奏强劲、有鼓点、电子/摇滚/说唱风格。❌❌❌ 绝对禁止选这些歌：抒情情歌、慢歌、民谣、轻音乐、治愈系、催眠曲、悲伤情歌、钢琴曲、女声抒情。即使候选歌曲里有用户平时喜欢的抒情歌，也绝对不能选！如果候选里没有运动歌，宁可不选也不要选抒情歌！',
        '开车提神': '必须选节奏快、律动感强、能提神的歌曲。❌ 排除催眠曲、轻音乐、慢节奏抒情歌。',
        '深夜助眠': '必须选轻柔、舒缓、安静的歌曲。❌ 排除高能量、电子舞曲、重金属、快节奏歌曲。',
        '工作学习': '必须选轻柔、无歌词或低干扰的背景音乐。❌ 排除高能量、DJ舞曲、重金属。',
        '聚会派对': '必须选气氛热烈、适合派对的舞曲或流行歌。❌ 排除催眠曲、慢节奏悲伤情歌。',
        '独处放空': '必须选氛围感强、沉浸式的歌曲。❌ 排除过于吵闹的DJ舞曲。',
        '情绪低落': '必须选治愈、温暖、共情的歌曲。❌ 排除过度亢奋的电子舞曲和重金属。',
        '兴奋High': '必须选高能量、爆发力强的歌曲。❌ 排除慢节奏抒情、催眠曲、轻音乐。',
      };
      sceneRequirement = sceneFilters[sceneName] || '';
    }

    // 语言硬性要求
    let langRequirement = '';
    if (preferences?.language && preferences.language !== 'any') {
      if (preferences.language === 'western') {
        langRequirement = '语言要求：必须选英文/欧美歌曲，❌ 排除纯华语歌曲和纯日韩语歌曲。';
      } else if (preferences.language === 'chinese') {
        langRequirement = '语言要求：必须选华语歌曲，❌ 排除纯英文/欧美歌曲和纯日韩语歌曲。';
      } else if (preferences.language === 'japanese_korean') {
        langRequirement = '语言要求：必须选日语或韩语歌曲（歌手必须是日本/韩国艺人），❌ 排除纯英文歌曲（如Avicii/The Chainsmokers/Justin Bieber等欧美歌手）和纯华语歌曲。注意：K-pop歌曲即使歌名是英文（如BLACKPINK/BIGBANG的歌），只要歌手是韩国/日本艺人就可以选。';
      }
    }

    // 年代硬性要求
    let eraRequirement = '';
    if (preferences?.era && preferences.era !== 'any') {
      if (preferences.era === 'millennium') {
        eraRequirement = '年代要求：必须选2000年代（2000-2009年）的歌曲。❌ 排除2015年以后的新歌。';
      } else if (preferences.era === 'classic') {
        eraRequirement = '年代要求：必须选经典老歌/90年代及更早的歌曲。❌ 排除2010年以后的新歌（如"满天星辰不及你""星空剪影"等网络新歌绝对不能选）。';
      } else if (preferences.era === '2010s') {
        eraRequirement = '年代要求：必须选2010年代（2010-2019年）的流行歌曲。❌ 排除2020年以后的新歌和90年代老歌。';
      } else if (preferences.era === 'latest') {
        eraRequirement = '年代要求：必须选2023-2024年的新歌。❌ 排除2015年以前的老歌。';
      }
    }

    // 🔑 构建"当前需求"段（场景+语言+年代+自定义）
    const currentNeedParts: string[] = [];
    if (sceneRequirement) currentNeedParts.push(sceneRequirement);
    if (langRequirement) currentNeedParts.push(langRequirement);
    if (eraRequirement) currentNeedParts.push(eraRequirement);
    const currentNeedStr = currentNeedParts.length > 0
      ? `\n【🔑 当前需求 - 硬性要求，必须遵守！】\n${currentNeedParts.join('\n')}\n`
      : '';

    const prompt = `从以下候选歌曲中选出${targetCount}首最匹配的，并给出推荐理由。

${currentNeedStr}${profileDetail ? `【用户画像（仅参考口味，不覆盖上面的硬性要求）】\n${profileDetail}\n` : ''}【用户喜欢的歌曲（仅参考口味）】
${seedList}

${dislikeHint}${avoidHint}
【候选歌曲(共${limitedCandidates.length}首)】
${candidateList}

【要求】
1. 选${targetCount}首最匹配的
2. 平台多样性：尽量保证多样性，不要全部选自同一个平台
${hasCustom ? `3. 🔑 关键：用户需求是"${customPromptText}"，优先选歌名/歌手名/风格与该需求相关的歌曲
   - 不要选和需求完全无关的歌曲！
4. 推荐理由必须诚实具体，说明这首歌为什么和需求相关` : `3. 每首理由10-20字，说明推荐原因`}
${hasScene ? `4. 🔑 场景硬性要求：用户当前场景是"${sceneName}"${sceneKw ? `(${sceneKw})` : ''}，必须只选符合该场景的歌曲！
   - 推荐理由必须说明这首歌为什么适合${sceneName}场景
   - ❌ 不要选不符合${sceneName}场景的歌曲，即使它们是用户平时喜欢的！` : ''}
${langRequirement ? `5. ${langRequirement}` : ''}
${eraRequirement ? `6. ${eraRequirement}` : ''}

输出JSON数组：
[{"i":1,"r":"理由"},{"i":2,"r":"理由"}]`;

    // 🔑 声明在try外部，catch块也能访问
    let aiResponse = '';

    try {
      // 🔑 详细日志：记录prompt大小和关键参数
      const promptChars = prompt.length;
      const candidateCount = limitedCandidates.length;
      const maxTokens = Math.min(targetCount * 80, 5000);
      console.log(`[AI] rankCandidates 开始: 模型=${model}, 候选=${candidateCount}首, 目标=${targetCount}首, max_tokens=${maxTokens}, prompt长度=${promptChars}字符`);

      const aiStartTime = Date.now();
      const result = await this.ai.run(model, {
        messages: [
          { role: 'system', content: '你是音乐推荐助手。只输出JSON数组，不要解释。不要思考过程，直接输出结果。' },
          { role: 'user', content: prompt }
        ],
        // 🔑 qwen3-30b-a3b 是思考模型，推理token会消耗max_tokens，必须给足够空间
        max_tokens: Math.min(targetCount * 200, 10000),
        temperature: 0.6,
      });
      const aiElapsed = Date.now() - aiStartTime;

      // 🔑 提取AI响应，确保是字符串
      const rawResp = result.response ||
                       result.generated_text ||
                       result.output ||
                       result.text ||
                       (Array.isArray(result.choices) && result.choices[0]?.message?.content) ||
                       '';
      aiResponse = typeof rawResp === 'string' ? rawResp : JSON.stringify(rawResp);
      const response = aiResponse;

      // 🔑 详细日志：响应长度、前500字、后200字、是否有结尾
      console.log(`[AI] rankCandidates AI响应: 耗时=${aiElapsed}ms, 长度=${response.length}字符`);
      console.log(`[AI] rankCandidates 响应前500字: ${response.substring(0, 500)}`);
      if (response.length > 500) {
        console.log(`[AI] rankCandidates 响应后200字: ...${response.substring(response.length - 200)}`);
      }
      console.log(`[AI] rankCandidates 响应是否以]结尾: ${response.trim().endsWith(']')}`);
      console.log(`[AI] rankCandidates result对象keys: ${Object.keys(result).join(',')}`);

      if (!response || response.trim().length === 0) {
        throw new Error(`AI返回空响应 (result keys: ${Object.keys(result).join(',')}, 耗时: ${aiElapsed}ms)`);
      }

      let jsonStr = response.trim();
      // 去除markdown代码块
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
        console.log('[AI] rankCandidates 检测到markdown代码块，已去除');
      }

      // 🔑 宽松JSON提取：找第一个[到最后一个]
      let jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
        console.log(`[AI] rankCandidates 提取JSON数组: 长度=${jsonStr.length}字符`);
      } else {
        // 🔑 截断修复：AI响应被max_tokens截断，没有结尾的]
        // 找第一个[，然后手动补上]
        const startIdx = jsonStr.indexOf('[');
        if (startIdx >= 0) {
          jsonStr = jsonStr.substring(startIdx);
          // 去除尾部不完整的元素（最后一个逗号后的内容）
          jsonStr = jsonStr.replace(/,\s*[^,]*$/, '');
          // 补上]
          if (!jsonStr.endsWith(']')) jsonStr += ']';
          console.log(`[AI] rankCandidates 截断修复: 补全JSON, 长度=${jsonStr.length}字符`);
        } else {
          console.error('[AI] rankCandidates 未找到JSON数组标记[...]');
          throw new Error('AI响应中未找到JSON数组: ' + response.substring(0, 200));
        }
      }

      // 🔑 清洗畸形JSON
      jsonStr = jsonStr.replace(/\[\(/g, '[').replace(/\)\]/g, ']');
      jsonStr = jsonStr.replace(/,\s*\]/g, ']');

      // 🔑 尝试JSON.parse，捕获具体错误位置
      let ranked: any;
      try {
        ranked = JSON.parse(jsonStr);
      } catch (parseErr: any) {
        // JSON解析失败，记录具体错误和附近内容
        const pos = parseErr.message.match(/position (\d+)/)?.[1];
        if (pos) {
          const around = jsonStr.substring(Math.max(0, Number(pos) - 50), Number(pos) + 50);
          console.error(`[AI] rankCandidates JSON解析失败: ${parseErr.message}`);
          console.error(`[AI] rankCandidates 错误位置附近: ...${around}...`);
        } else {
          console.error(`[AI] rankCandidates JSON解析失败: ${parseErr.message}`);
        }
        throw parseErr;
      }

      if (Array.isArray(ranked)) {
        console.log(`[AI] rankCandidates JSON解析成功: ${ranked.length}个元素`);
        console.log(`[AI] rankCandidates 前3个元素: ${JSON.stringify(ranked.slice(0, 3))}`);

        const validResults = ranked.filter((r: any) => {
          const idx = r.i || r.index;
          return typeof idx === 'number' && idx >= 1 && idx <= limitedCandidates.length;
        }).map((r: any) => ({
          index: r.i || r.index,
          reason: r.r || r.reason || '基于您的听歌偏好推荐',
          category: r.c || r.category || 'A'
        })).slice(0, targetCount);

        if (validResults.length > 0) {
          console.log(`[AI] rankCandidates 成功: ${ranked.length}个元素 → ${validResults.length}首有效`);
          return { songs: validResults, method: 'ai' as const };
        }

        console.error(`[AI] rankCandidates JSON解析成功但无有效元素: 原始${ranked.length}个, 格式示例=${JSON.stringify(ranked.slice(0, 2))}`);
        throw new Error('AI返回的JSON无有效元素');
      }

      throw new Error('AI返回的不是JSON数组: ' + JSON.stringify(ranked).substring(0, 150));
    } catch (error: any) {
      console.error('[AI] rankCandidates 失败:', error.message);
      console.error('[AI] rankCandidates 堆栈:', error.stack?.split('\n').slice(0, 3).join(' | '));
      throw new Error(`AI排序失败: ${error.message}`);
    }
  }

  getAvailableModels(): string[] {
    return [...DEFAULT_MODELS];
  }

  validateModel(model: string): boolean {
    return DEFAULT_MODELS.includes(model) || model.startsWith('@cf/');
  }
}
