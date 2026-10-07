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
  /** 是否显示翻译费用（回复下面、菜单、状态栏） */
  showCost: boolean
}

/** 一条回复（英文文本块）的翻译 */
export type Translation = {
  zh?: string
  pending?: boolean
  /** 正在译它的那一份插件（每次载入一个标记）。插件重载后对不上，说明原来那次翻译已经随重载没了 */
  owner?: string
  error?: string
  /** 美元，按 API 价格估算 */
  cost: number
}

/** 问答框（AskUserQuestion）里的一个问题：插件会翻译的字段，其余字段原样带着 */
export type AskQuestion = {
  question: string
  header: string
  description?: string
  placeholder?: string
  options?: { label: string; description?: string; preview?: string }[]
  [field: string]: unknown
}

/** 问答框的回答（AskUserQuestion 的结果）：问题文本 → 选的选项（多选用逗号隔开）或自己打的字 */
export type AskAnswer = {
  questions: AskQuestion[]
  answers: Record<string, string>
  response?: string
  annotations?: Record<string, { notes?: string; preview?: string }>
  [field: string]: unknown
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
      /** 问答框的回答那一行：这次调用的 id → 你看到的中文版回答 */
      answered: Record<string, AskAnswer>
      /** 本会话翻译累计（美元） */
      spent: number
    }
  }
}
