// zh-translate 在 $.state 里保存的值
export type Config = {
  /** 总开关 */
  enabled: boolean
  /** only：回复只显示中文；both：英文下面附中文 */
  mode: 'only' | 'both'
  /** all：每条回复都翻；final：只翻一轮最后的回复 */
  scope: 'all' | 'final'
  /** 翻译用的模型：别名或完整 ID */
  model: string
}

/** 一条回复（英文文本块）的翻译 */
export type Translation = {
  zh?: string
  pending?: boolean
  error?: string
  /** 美元，按 API 价格估算 */
  cost: number
}

/** 这一轮：你发的是不是中文、原文是什么、最后一次调用工具之后的回复文本 */
export type Turn = { zh: boolean; prompt: string; finalTexts: string[] }

declare module 'claude-code' {
  interface PluginState {
    'zh-translate': {
      config: Config
      /** 发给 Claude 的英文 → 你打的中文 */
      sent: Record<string, string>
      /** 回复的英文 → 翻译 */
      replies: Record<string, Translation>
      turn: Turn
      /** 本会话翻译累计（美元） */
      spent: number
    }
  }
}
