// zh-translate：用中文和 Claude Code 对话。
// 发送：你打的中文译成英文，只把英文发给 Claude；你那一行显示中文，下面一行是发出去的英文。
// 回复：Claude 的英文回复写完一段就在后台翻译，译好后在原处显示成中文（only）或附在英文下面（both）。
// 问答框（AskUserQuestion）：问题和选项显示成中文；你的回答以英文交给 Claude，回答那一行显示中文。
// 命令：/zh on | off | only | both | all | final，/zh-model 上下键选择翻译模型。
// 设置存在 ~/.claude/zh-translate/config.json，词表在同目录 glossary.txt（每行“中文 = English”）。
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AskAnswer, AskQuestion, Config, Translation, Turn } from '../types'

const PANE = 'zh-model'
const SETTINGS = 'zh-settings'
const CJK = /[㐀-鿿豈-﫿]/
const CJK_G = /[㐀-鿿豈-﫿]/g
const FENCE = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm

const DEFAULT_CONFIG: Config = { enabled: true, mode: 'only', scope: 'all', model: 'sonnet', showCost: true }
const configAtom = atom({ plugin: 'zh-translate', key: 'config' } as const, DEFAULT_CONFIG)
const sentAtom = atom({ plugin: 'zh-translate', key: 'sent' } as const, {} as Record<string, string>)
const repliesAtom = atom({ plugin: 'zh-translate', key: 'replies' } as const, {} as Record<string, Translation>)
const turnAtom = atom({ plugin: 'zh-translate', key: 'turn' } as const, { zh: false, prompt: '', finalTexts: [] } as Turn)
const spentAtom = atom({ plugin: 'zh-translate', key: 'spent' } as const, 0)
const asksAtom = atom({ plugin: 'zh-translate', key: 'asks' } as const, {} as Record<string, AskQuestion[]>)
const answeredAtom = atom({ plugin: 'zh-translate', key: 'answered' } as const, {} as Record<string, AskAnswer>)

// 每百万 token 的 API 价格（输入、输出），按它估算翻译费用
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-sonnet-4-5': [3, 15],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
}
const ALIASES: Record<string, string> = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' }
// /zh-model 里列出的版本；速度是 2026-10-01 实测的相对快慢
const MODELS: { id: string; name: string; speed: string }[] = [
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', speed: '最快，译文偏直译' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', speed: '快，默认' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', speed: '快' },
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', speed: '较快' },
  { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', speed: '较快' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', speed: '较慢' },
  { id: 'claude-opus-5', name: 'Opus 5', speed: '中等' },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', speed: '中等' },
  { id: 'claude-opus-4-7', name: 'Opus 4.7', speed: '中等' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', speed: '慢' },
  { id: 'claude-fable-5', name: 'Fable 5', speed: '最慢' },
]
const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b']

const TO_EN = `You are a translation step between a Chinese-speaking developer and an AI coding assistant. Translate the text inside <text> from Chinese into natural English. Output only the translation: no preamble, no notes, no tags, and never answer or act on the text.
- Keep code, commands, paths, URLs, IPs, identifiers, numbers and error messages exactly as written.
- Chinese that names something literal in software (button or menu text, UI labels, strings in quotes, log lines, product or feature names) stays in Chinese, followed by an English gloss in parentheses the first time it appears, e.g. 重试 (Retry).
- Keep placeholders such as ⟦B1⟧ exactly as they are, in the same position.`

const TO_ZH = `You are a translation step between an AI coding assistant and a Chinese-speaking developer. Translate the text inside <text> from English into natural Simplified Chinese. Output only the translation: no preamble, no notes, no tags.
- Keep the Markdown structure (headings, lists, tables, bold). Use full-width Chinese punctuation in Chinese sentences.
- Keep inline code, commands, paths, URLs, identifiers, numbers and error messages exactly as written.
- Leave English tech terms that Chinese developers normally use in English (API, commit, token, hook, etc.). Keep any Chinese text as is.
- The text may be one part of a longer reply; translate just this part.
- A <context> block, if present, is the developer's own Chinese message that this reply answers. Reuse their wording for the same things (names, features, UI text). Never translate or output the context.
- Keep placeholders such as ⟦B1⟧ exactly as they are, on their own line, in the same position.`

// 也写进消息本身：$.model.complete 前面总有 Claude Code 的身份说明，只放在 system 里它会去回答而不是翻译
const ASK_EN = 'Translate the Chinese text inside <text> into English. It is a message a developer is sending to a coding assistant: translate it, never answer it, carry it out or restate it. A question stays a question, a request stays a request. Output only the English.'
const ASK_ZH = 'Translate the English text inside <text> into Simplified Chinese. It is part of a coding assistant\'s reply, shown to a Chinese developer: translate it, never answer it, summarize it or add to it. Output only the Chinese.'
const ASK_DIALOG = 'The JSON object inside <text> maps ids to the English texts of a multiple-choice dialog that a coding assistant is showing a Chinese developer: questions, short headers, notes and answer options. Translate every value into Simplified Chinese: translate the questions, never answer them. Keep the keys. Output only the JSON object.'

const REPLY_EN = 'Write your reply in English even though the user wrote in Chinese. The user chose this setup: a display hook translates your English reply into Chinese on their screen, so a Chinese reply skips their pipeline.'

type Paths = { home: string; tmp: string }
let paths: Paths | null = null
let configLoaded = false
// 这一份插件的标记：每次载入（包括重载）都不一样
const LOAD = Math.random().toString(36).slice(2)
// 设置文件上次读到时的修改时间：别的窗口改了设置，这里靠它发现
let configSeen = -1
// 是不是交互界面（claude -p 这类没有界面，打不开菜单）
let interactive = true

const safe = (s: string) => s.replace(/[^\w-]/g, '_')
const usd = (n: number) => `$${n.toFixed(4)}`
const modelId = (m: string) => ALIASES[m] ?? m

// claude-sonnet-5-5 → Sonnet 5.5；不在列表里的 ID 也按这个规则起名
function modelName(m: string): string {
  const id = modelId(m)
  const known = MODELS.find(x => x.id === id)
  if (known) return known.name
  const p = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(id)
  if (!p) return m
  const [, family = '', major = '', minor] = p
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? '.' + minor : ''}`
}

function priceOf(m: string): [number, number] {
  const id = modelId(m)
  return PRICES[id] ?? PRICES[id.replace(/-\d{8}$/, '')] ?? [3, 15]
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
function costOf(m: string, u: Usage): number {
  const [i, o] = priceOf(m)
  return (u.input_tokens * i + u.cache_creation_input_tokens * i * 1.25 + u.cache_read_input_tokens * i * 0.1 + u.output_tokens * o) / 1e6
}

// 代码块（输入里还有连续的非中文行，如粘贴的日志）换成占位符，原样放回
function mask(text: string, blocks: string[], plainRuns: boolean): string {
  const put = (s: string) => (blocks.push(s), `⟦B${blocks.length}⟧`)
  let t = text.replace(FENCE, put)
  if (plainRuns) {
    const lines = t.split('\n'), res: string[] = []
    const plain = (l: string | undefined) => l !== undefined && !!l.trim() && !CJK.test(l) && !/^⟦B\d+⟧$/.test(l.trim())
    for (let i = 0; i < lines.length;) {
      let j = i
      while (j < lines.length && plain(lines[j])) j++
      if (j - i >= 2) { res.push(put(lines.slice(i, j).join('\n'))); i = j }
      else res.push(lines[i++] ?? '')
    }
    t = res.join('\n')
  }
  return t
}

function unmask(text: string, blocks: string[]): string {
  const used = new Set<number>()
  let t = text.replace(/⟦B(\d+)⟧/g, (m: string, n: string) => {
    const b = blocks[+n - 1]
    if (b === undefined) return m
    used.add(+n)
    return b
  })
  blocks.forEach((b, i) => { if (!used.has(i + 1)) t += '\n\n' + b })
  return t
}

// 去掉代码、路径、链接后，英文字母明显多于汉字才算需要译成中文
function needsZh(text: string): boolean {
  const prose = text
    .replace(FENCE, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s，。、）)]+/g, '')
  const latin = (prose.match(/[A-Za-z]/g) || []).length
  const cjk = (prose.match(CJK_G) || []).length
  return latin >= 3 && cjk * 5 < latin
}

function statusText(c: Config, spent: number): string {
  const show = c.scope === 'final'
    ? `只译最后的回复（你的消息照常翻译，中间过程不翻译）；${c.mode === 'both' ? '英文下面附中文' : '只显示中文'}`
    : c.mode === 'both' ? '每条回复英文下面附中文' : '每条回复只显示中文'
  const state = c.enabled ? `已开启（${show}）` : '已关闭'
  const cost = c.showCost ? `本会话翻译累计 ${usd(spent)}` : '不显示费用'
  return `中文翻译${state}，翻译模型：${modelName(c.model)}，${cost}。\n命令：/zh on | off | only | both | all | final | cost on | cost off，/zh-model 选翻译模型`
}

// ---------- 读写文件（家目录和临时目录只问一次） ----------
async function where($: any): Promise<Paths> {
  if (paths) return paths
  const r = await $.process.run(['node', '-e', 'const os=require("os");process.stdout.write(JSON.stringify({home:os.homedir(),tmp:os.tmpdir()}))'])
  paths = JSON.parse(r.stdout) as Paths
  return paths
}

async function readText($: any, file: string): Promise<string> {
  try { return await $.fs.read(file) } catch { return '' }
}

async function configFile($: any): Promise<string> {
  return `${(await where($)).home}/.claude/zh-translate/config.json`
}

async function stateFile($: any): Promise<string> {
  return `${(await where($)).tmp}/claude-zh/plugin-state-${safe(await $.session.id())}.json`
}

async function configMtime($: any): Promise<number> {
  try { return (await $.fs.stat(await configFile($))).mtimeMs } catch { return -1 }
}

// 设置文件里存的设置；还没有设置文件时为 null
async function readSaved($: any): Promise<Config | null> {
  try {
    const saved: Partial<Config> = JSON.parse(await readText($, await configFile($)))
    return { ...DEFAULT_CONFIG, ...saved, model: saved.model || DEFAULT_CONFIG.model }
  } catch { return null }
}

const sameConfig = (a: Config, b: Config) =>
  Object.keys({ ...a, ...b }).every(k => (a as any)[k] === (b as any)[k])

async function loadConfig($: any): Promise<Config> {
  configSeen = await configMtime($)
  const c = (await readSaved($)) ?? { ...DEFAULT_CONFIG }
  // 没变就不动，免得屏幕上的回复白白重画
  if (!configLoaded || !sameConfig(await read($, configAtom), c)) await update($, configAtom, () => c)
  configLoaded = true
  return c
}

// 设置对所有窗口生效：设置文件被别的窗口改过（修改时间变了）就重新读
async function syncConfig($: any): Promise<void> {
  if (configLoaded && (await configMtime($)) === configSeen) return
  await loadConfig($)
}

async function getConfig($: any): Promise<Config> {
  return configLoaded ? read($, configAtom) : loadConfig($)
}

async function saveConfig($: any, change: Partial<Config>): Promise<Config> {
  // 在设置文件现有的内容上改，不用本窗口记着的旧设置，免得把别的窗口刚改的设置盖回去
  const base = (await readSaved($)) ?? (await getConfig($))
  const c = { ...base, ...change }
  await update($, configAtom, () => c)
  await $.fs.write(await configFile($), JSON.stringify(c, null, 2))
  configSeen = await configMtime($)
  return c
}

// 会话里的翻译另存一份，恢复会话或插件重载后还能显示；状态栏也从这里读本会话累计
async function saveState($: any): Promise<void> {
  const replies = await read($, repliesAtom)
  const done: Record<string, Translation> = {}
  for (const [k, v] of Object.entries(replies)) if (v.zh) done[k] = { zh: v.zh, cost: v.cost }
  await $.fs.write(await stateFile($), JSON.stringify({ sent: await read($, sentAtom), replies: done, answered: await read($, answeredAtom), spent: await read($, spentAtom) }))
}

async function loadState($: any): Promise<void> {
  let s: { sent?: Record<string, string>; replies?: Record<string, Translation>; answered?: Record<string, AskAnswer>; spent?: number } = {}
  try { s = JSON.parse(await readText($, await stateFile($))) } catch { return }
  await update($, sentAtom, m => ({ ...(s.sent ?? {}), ...m }))
  await update($, repliesAtom, m => ({ ...(s.replies ?? {}), ...m }))
  await update($, answeredAtom, m => ({ ...(s.answered ?? {}), ...m }))
  await update($, spentAtom, n => Math.max(n, s.spent ?? 0))
}

async function glossary($: any): Promise<string> {
  const pairs = (await readText($, `${(await where($)).home}/.claude/zh-translate/glossary.txt`)).split(/\r?\n/)
    .map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
  return pairs.length
    ? `\n- Glossary, one "Chinese = English" pair per line. Into Chinese, use the Chinese side where the English side (or a close variant) appears; into English, use the English side. Natural wording around a term is fine.\n${pairs.map(p => `  ${p}`).join('\n')}\n- Write the translation once. Never add notes, corrections or a second version.`
    : ''
}

// ---------- 翻译 ----------
type Done = { ok: true; text: string; cost: number } | { ok: false; reason: string; cost: number }

// 翻译模型没给出译文的原因，说成能看懂的话
function whyFailed(r: { reason: string; status?: number }): string {
  if (r.reason === 'empty-reply') return '翻译模型没有给出译文，可能是这段内容没通过它的安全检查'
  if (r.reason === 'aborted') return '翻译超时'
  if (r.reason === 'api-error') return `翻译接口出错${r.status ? `（${r.status}）` : ''}，可能是网络或服务暂时有问题`
  return r.reason
}

async function translate($: any, model: string, system: string, ask: string, text: string, context = ''): Promise<Done> {
  const r = await $.model.complete({
    model,
    system,
    prompt: `${ask}\n\n${context ? `<context>\n${context.slice(0, 2000)}\n</context>\n\n` : ''}<text>\n${text}\n</text>`,
    effort: 'low',
    maxTokens: 16000,
    timeoutMs: 180000,
  })
  const cost = costOf(model, r.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  if (!r.isAnswered) return { ok: false, reason: whyFailed(r), cost }
  return { ok: true, text: r.text.replace(/^\s*<text>\s*|\s*<\/text>\s*$/g, '').trim(), cost }
}

async function addSpent($: any, cost: number): Promise<number> {
  return update($, spentAtom, n => n + cost)
}

// 后台翻一段回复；译好后写进 repliesAtom，显示的地方会自己重画
async function translateReply($: any, en: string): Promise<void> {
  const key = en.trim()
  if (!key || !needsZh(key)) return
  const known = (await read($, repliesAtom))[key]
  // 正在译的不重复译；标着“翻译中”但不是这一份插件在译的（重载前开始的），那次翻译已经没了，重新译
  if (known && (known.zh || (known.pending && known.owner === LOAD))) return
  await update($, repliesAtom, m => ({ ...m, [key]: { pending: true, owner: LOAD, cost: 0 } }))
  const blocks: string[] = []
  let r: Done
  try {
    const c = await getConfig($)
    r = await translate($, c.model, TO_ZH + (await glossary($)), ASK_ZH, mask(key, blocks, false), (await read($, turnAtom)).prompt)
  } catch (err) {
    // 请求没发出去（比如引擎拒绝）：记成没翻译，别一直显示“翻译中”
    r = { ok: false, reason: `翻译请求没有发出去（${String((err as any)?.message ?? err).slice(0, 80)}）`, cost: 0 }
  }
  await addSpent($, r.cost)
  const entry: Translation = r.ok ? { zh: unmask(r.text, blocks), cost: r.cost } : { error: r.reason, cost: r.cost }
  await update($, repliesAtom, m => ({ ...m, [key]: entry }))
  await saveState($)
}

// ---------- 问答框（AskUserQuestion） ----------
// 先等译文这么久：译好了问答框直接以中文弹出；更慢就先弹英文
const ASK_WAIT_MS = 6000

// 问答框按问题文本认：画它的时候拿不到这次调用的 id
const askKey = (qs: readonly { question: string }[]) => qs.map(q => q.question).join('\n')

// 要翻的文字：问题、标题、说明、选项（选项的预览是代码或示意图，不翻）
function askTexts(qs: AskQuestion[]): Record<string, string> {
  const t: Record<string, string> = {}
  qs.forEach((q, i) => {
    t[`q${i}`] = q.question
    if (q.header) t[`h${i}`] = q.header
    if (q.description) t[`d${i}`] = q.description
    if (q.placeholder) t[`p${i}`] = q.placeholder
    q.options?.forEach((o, j) => {
      t[`o${i}_${j}`] = o.label
      if (o.description) t[`od${i}_${j}`] = o.description
    })
  })
  return t
}

// 把译文填回问题里；还得合问答框的规矩：标题最多 12 个字，问题和同一题的选项不能重名，不合就用英文
function askZh(qs: AskQuestion[], zh: Record<string, unknown>): AskQuestion[] {
  const pick = (k: string, en: string) => {
    const v = zh[k]
    return typeof v === 'string' && v.trim() ? v.trim() : en
  }
  const out = qs.map((q, i) => {
    const options = q.options?.map((o, j) => ({
      ...o,
      label: pick(`o${i}_${j}`, o.label),
      ...(o.description ? { description: pick(`od${i}_${j}`, o.description) } : {}),
    }))
    const distinct = !options || new Set(options.map(o => o.label)).size === options.length
    return {
      ...q,
      question: pick(`q${i}`, q.question),
      header: [...pick(`h${i}`, q.header)].slice(0, 12).join(''),
      ...(q.description ? { description: pick(`d${i}`, q.description) } : {}),
      ...(q.placeholder ? { placeholder: pick(`p${i}`, q.placeholder) } : {}),
      ...(options ? { options: distinct ? options : q.options } : {}),
    }
  })
  return new Set(out.map(q => q.question)).size === out.length ? out : qs
}

// 问答框译成中文，存进 asksAtom，问答框跟着重画；没译成返回 null（照常显示英文）
async function translateAsk($: any, qs: AskQuestion[]): Promise<AskQuestion[] | null> {
  try {
    const c = await getConfig($)
    const texts = JSON.stringify(askTexts(qs), null, 1)
    const r = await translate($, c.model, TO_ZH + (await glossary($)), ASK_DIALOG, texts, (await read($, turnAtom)).prompt)
    await addSpent($, r.cost)
    if (!r.ok) return null
    const json = r.text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')
    const zh = askZh(qs, JSON.parse(json))
    await update($, asksAtom, m => ({ ...m, [askKey(qs)]: zh }))
    return zh
  } catch {
    return null
  }
}

// 你在问答框里打的字：是中文就译成英文；没译成就照原样
async function answerEn($: any, text: string): Promise<string> {
  if (!CJK.test(text)) return text
  try {
    const c = await getConfig($)
    const blocks: string[] = []
    const r = await translate($, c.model, TO_EN + (await glossary($)), ASK_EN, mask(text, blocks, true))
    await addSpent($, r.cost)
    return r.ok ? unmask(r.text, blocks).trim() : text
  } catch {
    return text
  }
}

// 第 i 题选项的对照：显示的（中文或英文）标签 → 另一边的标签
function labelMap(from: AskQuestion | undefined, to: AskQuestion | undefined, also?: AskQuestion): Map<string, string> {
  const m = new Map<string, string>()
  also?.options?.forEach((o, j) => m.set(o.label, to?.options?.[j]?.label ?? o.label))
  from?.options?.forEach((o, j) => m.set(o.label, to?.options?.[j]?.label ?? o.label))
  return m
}

// 拆开一条回答（多选用逗号隔开）：在对照表里的是选的选项，换成对照的标签；其余是自己打的字
function splitAnswer(answer: string, labels: Map<string, string>): { picked: string[]; typed: string } {
  const parts = answer.split(', ')
  return {
    picked: parts.filter(p => labels.has(p)).map(p => labels.get(p)!),
    typed: parts.filter(p => !labels.has(p)).join(', '),
  }
}

// 问答框的回答换成英文给 Claude：选的中文选项换回原来的英文选项，自己打的中文译成英文
async function askAnswerEn($: any, en: AskQuestion[], shown: AskQuestion[], r: AskAnswer): Promise<AskAnswer> {
  const at = (k: string) => en.findIndex((q, i) => q.question === k || shown[i]?.question === k)
  const answers: Record<string, string> = {}
  for (const [k, a] of Object.entries(r.answers ?? {})) {
    const i = at(k)
    // 选的选项换回原来的英文，一个字不差；自己打的字（多选时排在选项后面）译成英文
    const { picked, typed } = splitAnswer(String(a), labelMap(shown[i], en[i], en[i]))
    answers[en[i]?.question ?? k] = [...picked, ...(typed ? [await answerEn($, typed)] : [])].join(', ')
  }
  const annotations: Record<string, { notes?: string; preview?: string }> = {}
  for (const [k, n] of Object.entries(r.annotations ?? {})) {
    annotations[en[at(k)]?.question ?? k] = n.notes ? { ...n, notes: await answerEn($, n.notes) } : n
  }
  return {
    ...r,
    questions: en,
    answers,
    ...(r.annotations ? { annotations } : {}),
    ...(r.response ? { response: await answerEn($, r.response) } : {}),
  }
}

// 回答那一行给你看的版本：问题和选项用你看到的中文，自己打的字照你打的
function askAnswerShown(en: AskQuestion[], shown: AskQuestion[], r: AskAnswer): AskAnswer {
  const at = (k: string) => en.findIndex((q, i) => q.question === k || shown[i]?.question === k)
  const answers: Record<string, string> = {}
  for (const [k, a] of Object.entries(r.answers ?? {})) {
    const i = at(k)
    const { picked, typed } = splitAnswer(String(a), labelMap(en[i], shown[i], shown[i]))
    answers[shown[i]?.question ?? k] = [...picked, ...(typed ? [typed] : [])].join(', ')
  }
  const annotations: Record<string, { notes?: string; preview?: string }> = {}
  for (const [k, n] of Object.entries(r.annotations ?? {})) annotations[shown[at(k)]?.question ?? k] = n
  return { ...r, questions: shown, answers, ...(r.annotations ? { annotations } : {}) }
}

// 打开一个菜单面板；没有界面可画（比如 claude -p）时返回 false，命令改成只回文字
async function openPane($: any, id: string, title: string, rows: number): Promise<boolean> {
  if (!interactive) return false
  try {
    const r = await $.ui.open({ id, title, focus: true, closeOnEscape: true, rows })
    return r?.isPlaced !== false
  } catch {
    return false
  }
}

// 先用新模型试译一个词，名字写错或账号用不了就不换
async function switchModel($: any, m: string): Promise<string> {
  const r = await translate($, m, TO_EN, ASK_EN, '你好')
  await addSpent($, r.cost)
  if (!r.ok) return `“${modelName(m)}”用不了，没有更换（${r.reason}）`
  await saveConfig($, { model: m })
  return `翻译模型已改为 ${modelName(m)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive !== false
    await loadConfig($)
    await loadState($)
    // 插件重载时没译完的回复（标着“翻译中”，但不是这一份插件在译）：重新译，不然会一直显示“翻译中”
    for (const [k, v] of Object.entries(await read($, repliesAtom))) if (v.pending && v.owner !== LOAD) void translateReply($, k)
    // 每 2 秒看一眼设置文件，别的窗口改了设置这里跟着变；看一眼只读文件的修改时间
    $.clock.every(2000, () => { void syncConfig($).catch(() => {}) })
    // immediate：Claude 正在回复时打 /zh 也立刻弹出菜单，和 /model 一样，不用等这一轮结束
    await $.command.register({ name: 'zh', description: '中文翻译设置菜单（也可以直接 /zh on | off | only | both | all | final）', immediate: true })
    await $.command.register({ name: 'zh-model', description: '选择中文翻译用的模型（上下键选择）', immediate: true })
    return next(e)
  })

  // ---------- 命令 ----------
  on('command.run', { command: 'zh' }, async ($, e) => {
    const a = e.args.trim().toLowerCase()
    await syncConfig($)
    let c = await getConfig($)
    let note = ''
    if (!a) {
      // 不带参数：打开设置菜单
      const opened = await openPane($, SETTINGS, '中文翻译设置', 15)
      return { text: opened ? '用上下键或 Tab 选择，回车切换，Esc 关闭。' : statusText(c, await read($, spentAtom)) }
    }
    if (a === 'on' || a === 'off') c = await saveConfig($, { enabled: a === 'on' })
    else if (a === 'only' || a === 'both') c = await saveConfig($, { enabled: true, mode: a })
    else if (a === 'all' || a === 'final') c = await saveConfig($, { enabled: true, scope: a })
    else if (/^cost\s+(on|off)$/.test(a)) c = await saveConfig($, { showCost: a.endsWith('on') })
    else if (a.startsWith('model ')) { note = (await switchModel($, a.slice(6).trim())) + '。'; c = await getConfig($) }
    else note = `不认识“${a}”。`
    return { text: note + statusText(c, await read($, spentAtom)) }
  })

  on('command.run', { command: 'zh-model' }, async $ => {
    await syncConfig($)
    const opened = await openPane($, PANE, '翻译模型', MODELS.length + 3)
    return { text: opened ? '用上下键或 Tab 选择翻译模型，回车确认，Esc 取消。' : '这里打不开选择列表，请用 /zh model <模型 ID> 切换。' }
  })

  // 设置菜单：每一项按下立即生效，当前的设置标 ●
  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await read($, configAtom)
    const spent = await read($, spentAtom)
    const set = (change: Partial<Config>) => () => saveConfig($, change)
    const choice = (key: string, label: string, isOn: boolean, onPress: () => unknown, hotkey: string) => (
      <Button key={key} hotkey={hotkey} variant={isOn ? 'primary' : undefined} label={`${isOn ? '●' : '○'} ${label}`} onPress={onPress} />
    )
    const toModels = async () => {
      await $.ui.close({ id: SETTINGS })
      await openPane($, PANE, '翻译模型', MODELS.length + 3)
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>{c.showCost ? `本会话翻译累计 ${usd(spent)}。` : ''}上下键或 Tab 选择，回车切换，Esc 关闭。</Text>
        <Text bold>翻译</Text>
        <Box flexDirection="row" columnGap={2}>
          {choice('on', '开启', c.enabled, set({ enabled: true }), '1')}
          {choice('off', '关闭', !c.enabled, set({ enabled: false }), '2')}
        </Box>
        <Text bold>回复怎么显示</Text>
        <Box flexDirection="row" columnGap={2}>
          {choice('only', '只显示中文', c.mode === 'only', set({ enabled: true, mode: 'only' }), '3')}
          {choice('both', '英文下面附中文', c.mode === 'both', set({ enabled: true, mode: 'both' }), '4')}
        </Box>
        <Text bold>翻译哪些回复</Text>
        <Box flexDirection="row" columnGap={2}>
          {choice('all', '每条回复', c.scope === 'all', set({ enabled: true, scope: 'all' }), '5')}
          {choice('final', '只翻每轮最后的回复', c.scope === 'final', set({ enabled: true, scope: 'final' }), '6')}
        </Box>
        <Text bold>显示翻译费用</Text>
        <Box flexDirection="row" columnGap={2}>
          {choice('cost-on', '显示', c.showCost, set({ showCost: true }), '7')}
          {choice('cost-off', '不显示', !c.showCost, set({ showCost: false }), '8')}
        </Box>
        <Text bold>翻译模型：{modelName(c.model)}</Text>
        <Box flexDirection="row" columnGap={2}>
          <Button key="model" hotkey="9" label="换模型…" onPress={toModels} />
          <Button key="done" hotkey="0" role="dismiss" label="完成" onPress={() => $.ui.close({ id: SETTINGS })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cur = modelId((await read($, configAtom)).model)
    const pick = async (id: string) => {
      $.ui.toast(`正在检查 ${modelName(id)}…`)
      const msg = await switchModel($, id)
      await $.ui.close({ id: PANE })
      $.ui.toast(msg)
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>当前：{modelName(cur)}。估价按一段约 70 词的回复算。</Text>
        {MODELS.map((m, i) => {
          const [pin, pout] = priceOf(m.id)
          const each = (650 * pin + 150 * pout) / 1e6
          return (
            <Button
              key={m.id}
              hotkey={HOTKEYS[i]}
              variant={m.id === cur ? 'primary' : undefined}
              label={`${m.name}${m.id === cur ? '（当前）' : ''} · ${m.speed} · 每段约 $${each.toFixed(4)}`}
              onPress={() => pick(m.id)}
            />
          )
        })}
      </Box>
    )
  })

  // ---------- 发送前：中文译成英文，只发英文 ----------
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'sdk') return next(e)
    const text = e.text.trim()
    if (text.startsWith('/')) return next(e)
    await syncConfig($)
    const c = await getConfig($)
    if (!c.enabled || !CJK.test(text)) {
      await update($, turnAtom, () => ({ zh: false, prompt: '', finalTexts: [] }))
      return next(e)
    }
    await update($, turnAtom, () => ({ zh: true, prompt: text, finalTexts: [] }))
    const blocks: string[] = []
    const r = await translate($, c.model, TO_EN + (await glossary($)), ASK_EN, mask(text, blocks, true))
    await addSpent($, r.cost)
    if (!r.ok) {
      $.ui.toast(`这条没有翻译，按中文原文发送：${r.reason}`)
      return next({ ...e, context: [...(e.context ?? []), REPLY_EN] })
    }
    const en = unmask(r.text, blocks).trim()
    await update($, sentAtom, m => ({ ...m, [en]: text }))
    await saveState($)
    return next({ ...e, text: en, context: [...(e.context ?? []), REPLY_EN] })
  })

  // ---------- 回复：每段写完就在后台翻译 ----------
  on('session.append', async ($, e, next) => {
    if (e.door !== 'response' || e.agentId !== undefined || e.message.type !== 'assistant') return next(e)
    const turn = await read($, turnAtom)
    const c = await getConfig($)
    if (!turn.zh || !c.enabled) return next(e)
    const content = e.message.content as { type: string; text?: string }[]
    if (content.some(b => b.type === 'tool_use')) {
      // 后面还要调用工具：只译最后回复时，之前的文字不算
      if (c.scope === 'final') await update($, turnAtom, t => ({ ...t, finalTexts: [] }))
      return next(e)
    }
    const texts = content.filter(b => b.type === 'text' && b.text?.trim()).map(b => b.text as string)
    if (c.scope === 'final') await update($, turnAtom, t => ({ ...t, finalTexts: [...t.finalTexts, ...texts] }))
    // 思考块不翻：屏幕上的思考摘要看着像普通文字，但引擎直接画它，没有绘制钩子，翻了也换不上去
    else for (const t of texts) void translateReply($, t) // 不等它：回复照常存下、照常显示，译好再换
    return next(e)
  })

  // 只译最后回复：一轮结束时翻最后一次调用工具之后的文字，等它译完这一轮才算结束
  // （反正要等中文；不等的话 claude -p 这类跑完就退出的场合会丢掉译文）
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const c = await getConfig($)
    const turn = await read($, turnAtom)
    if (c.enabled && c.scope === 'final' && turn.zh) {
      const texts = turn.finalTexts.length ? turn.finalTexts : e.answer ? [e.answer] : []
      await Promise.all(texts.map(t => translateReply($, t)))
    }
    return done
  })

  // ---------- 问答框（AskUserQuestion） ----------
  // 先等译文（最多 ASK_WAIT_MS）：译好了问答框直接以中文弹出；更慢就先弹英文，译好再换。
  // 你答完后，回答以英文交给 Claude
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined || e.tool !== 'AskUserQuestion') return next(e)
    const c = await getConfig($)
    if (!c.enabled || !(await read($, turnAtom)).zh) return next(e)
    const en = e.questions as unknown as AskQuestion[]
    const zhJob = translateAsk($, en)
    const early = await Promise.race([zhJob, $.clock.sleep(ASK_WAIT_MS).then(() => undefined, () => undefined)])
    const done = await next(early ? { ...e, questions: early as any } : e)
    if (done.deny !== undefined || done.isError) return done
    const shown = (await zhJob) ?? en
    const r = done.result as unknown as AskAnswer
    const enAnswer = await askAnswerEn($, en, shown, r)
    await update($, answeredAtom, m => ({ ...m, [e.tool_use_id]: askAnswerShown(en, shown, r) }))
    await saveState($)
    return { result: enAnswer as any, ...(done.context ? { context: done.context } : {}) }
  })

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const c = await read($, configAtom)
    const zh = (await read($, asksAtom))[askKey(e.props.questions as AskQuestion[])]
    if (!c.enabled || !zh) return next(e)
    return next({ ...e, props: { ...e.props, questions: zh } })
  })

  // 问答框的回答那一行：显示你看到的中文版
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== 'AskUserQuestion') return next(e)
    const c = await read($, configAtom)
    const shown = (await read($, answeredAtom))[e.props.tool_use_id]
    if (!c.enabled || !shown) return next(e)
    return next({ ...e, props: { ...e.props, output: shown } })
  })

  // ---------- 显示 ----------
  // 你那一行：显示你打的中文，下面一行是实际发给 Claude 的英文
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'composer' && e.props.origin.kind !== 'sdk') return next(e)
    const zh = (await read($, sentAtom))[e.props.text.trim()]
    if (!zh) return next(e)
    return next({ ...e, props: { ...e.props, text: `${zh}\n↳ ${e.props.text}` } })
  })

  // 回复：译好就换成中文；设置一改，屏幕上已有的回复跟着重画
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const c = await read($, configAtom)
    const tr = (await read($, repliesAtom))[e.props.text.trim()]
    if (!c.enabled || !tr) return next(e)
    if (tr.pending) return next({ ...e, props: { ...e.props, text: `${e.props.text}\n\n*（翻译中…）*` } })
    if (!tr.zh) return next({ ...e, props: { ...e.props, text: `${e.props.text}\n\n*（这一段没有翻译，上面是英文原文。原因：${tr.error}）*` } })
    // 关了“显示翻译费用”就不写金额；both 模式的分隔线照留
    const cost = c.showCost ? `本条 ${usd(tr.cost)} · 本会话翻译累计 ${usd(await read($, spentAtom))}` : ''
    const text = c.mode === 'both'
      ? `${e.props.text}\n\n───── 中文 ─────${cost ? ` ${cost}` : ''}\n\n${tr.zh}`
      : cost ? `${tr.zh}\n\n*（翻译费用：${cost}）*` : tr.zh
    return next({ ...e, props: { ...e.props, text } })
  })
}
