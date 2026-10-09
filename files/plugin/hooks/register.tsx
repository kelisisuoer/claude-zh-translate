// zh-translate：用中文和 Claude Code 对话。
// 发送：你打的中文译成英文，只把英文发给 Claude；你那一行显示中文，下面一行是发出去的英文。
// 回复：Claude 的英文回复写完一段就在后台翻译，译好后在原处显示成中文（only）或附在英文下面（both）。
// 问答框（AskUserQuestion）：问题和选项显示成中文；你的回答以英文交给 Claude，回答那一行显示中文。
// 翻译可以用你的 Claude 账号，也可以用外部 API（DeepSeek 等，/zh api 设置，出错时改用 Claude 账号）。
// 命令：/zh on | off | only | both | all | final，/zh-model 上下键选择翻译模型。
// 设置存在 ~/.claude/zh-translate/config.json，词表在同目录 glossary.txt（每行“中文 = English”）。
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ApiConfig, ApiModel, AskAnswer, AskQuestion, Config, Translation, Turn } from '../types'

const PANE = 'zh-model'
const SETTINGS = 'zh-settings'
const API_PANE = 'zh-api'
const CJK = /[㐀-鿿豈-﫿]/
const CJK_G = /[㐀-鿿豈-﫿]/g
// 截图、粘贴内容在消息里的占位：[Image #4]、[Pasted text #1 +20 lines]
const PLACEHOLDER = /\[(?:Image|Pasted text)[^\]]*\]/g
const FENCE = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm

const DEFAULT_CONFIG: Config = {
  enabled: true, mode: 'only', scope: 'all', model: 'sonnet', showCost: true,
  provider: 'claude', api: { format: 'openai', url: 'https://api.deepseek.com', model: '', models: [] },
}
const configAtom = atom({ plugin: 'zh-translate', key: 'config' } as const, DEFAULT_CONFIG)
const sentAtom = atom({ plugin: 'zh-translate', key: 'sent' } as const, {} as Record<string, string>)
const repliesAtom = atom({ plugin: 'zh-translate', key: 'replies' } as const, {} as Record<string, Translation>)
// 新会话按中文算：插件开着就是要用中文（第一条只发截图时，回复也翻）
const turnAtom = atom({ plugin: 'zh-translate', key: 'turn' } as const, { zh: true, prompt: '', finalTexts: [] } as Turn)
const spentAtom = atom({ plugin: 'zh-translate', key: 'spent' } as const, 0)
const answeredAtom = atom({ plugin: 'zh-translate', key: 'answered' } as const, {} as Record<string, AskAnswer>)
const apiNoteAtom = atom({ plugin: 'zh-translate', key: 'apiNote' } as const, '')

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
const HOTKEYS = [...'123456789abcdefghijklmnopqrstuvwxyz']

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
// 状态（共享缓存 + 本会话累计）读进来了没有；没读之前不写文件
let stateLoaded = false
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

// ---------- 外部 API（DeepSeek 等，OpenAI 兼容；或 Anthropic） ----------
// 已知的外部模型价格（美元/百万 token，输入、输出）。DeepSeek 按高峰价，宁可估高；不在表里的算不出价格
const API_PRICES: Record<string, [number, number]> = {
  'deepseek-flash': [0.3, 1.2],
  'deepseek-v4-pro': [1.32, 3.96],
}

// 密钥只显示头尾：sk-…00a3
const maskKey = (k: string) => (k ? `${k.slice(0, 3)}…${k.slice(-4)}` : '')

// 外部模型的显示名：模型列表给了名字就用名字（DeepSeek-V4.1-Flash），否则用 ID
const apiName = (api: ApiConfig, id = api.model) => api.models.find(m => m.id === id)?.name || id

// 当前在用的翻译模型叫什么
const currentName = (c: Config) => (c.provider === 'api' && c.api.model ? apiName(c.api) : modelName(c.model))

// 一段约 70 词的回复翻一次大概多少钱；算不出来返回空
function eachCost(model: string, api: boolean): string {
  const p = api ? API_PRICES[model] : priceOf(model)
  return p ? `每段约 $${((650 * p[0] + 150 * p[1]) / 1e6).toFixed(4)}` : '价格未知'
}

// 接口地址：OpenAI 兼容的照填的地址拼（DeepSeek 是 https://api.deepseek.com，很多服务的地址带 /v1）；
// Anthropic 的补上 /v1
function endpoint(api: ApiConfig, path: string): string {
  const base = api.url.trim().replace(/\/+$/, '')
  return (api.format === 'anthropic' && !base.endsWith('/v1') ? base + '/v1' : base) + path
}

function apiHeaders(api: ApiConfig, key: string): Record<string, string> {
  return api.format === 'anthropic'
    ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${key}` }
}

// 接口报错说成能看懂的话，带上服务自己给的说明
function apiError(status: number, body: string): string {
  let msg = ''
  try {
    const j = JSON.parse(body)
    msg = String(j.error?.message ?? j.message ?? '')
  } catch {}
  const why = status === 401 || status === 403 ? '密钥不对或没有权限'
    : status === 402 ? '账户余额不足'
    : status === 429 ? '请求太频繁或额度用完了'
    : status === 404 ? '地址或模型名不对'
    : `接口出错（${status}）`
  return msg ? `${why}：${msg.slice(0, 80)}` : why
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
  return `中文翻译${state}，翻译模型：${currentName(c)}${c.provider === 'api' ? '（外部 API）' : ''}，${cost}。\n命令：/zh on | off | only | both | all | final | cost on | cost off，/zh-model 选翻译模型，/zh api 设置外部 API（/zh api off 改回 Claude 账号）`
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

// 外部 API 的密钥单独存一个文件，不进设置文件（设置文件状态栏也读）
async function keyFile($: any): Promise<string> {
  return `${(await where($)).home}/.claude/zh-translate/api-key`
}

async function apiKey($: any): Promise<string> {
  return (await readText($, await keyFile($))).trim()
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
  Object.keys({ ...a, ...b }).every(k => JSON.stringify((a as any)[k]) === JSON.stringify((b as any)[k]))

async function loadConfig($: any): Promise<Config> {
  const mt = await configMtime($)
  const saved = await readSaved($)
  // 设置文件在、却读不出来（多半是别的窗口正在写，读到了半个文件）：先用着手上这份，
  // 下次再读（configSeen 不更新，所以下一次还会再试）。绝不能退回默认设置，
  // 否则翻译模型、是否显示费用这些会莫名其妙变回去，还会被写回文件
  if (!saved && mt >= 0) return configLoaded ? read($, configAtom) : { ...DEFAULT_CONFIG }
  configSeen = mt
  const c = saved ?? { ...DEFAULT_CONFIG }
  // 没变就不动，免得屏幕上的回复白白重画
  const changed = !configLoaded || !sameConfig(await read($, configAtom), c)
  if (changed) await update($, configAtom, () => c)
  configLoaded = true
  // 换了模型（也可能是别的窗口换的）：把这个窗口在用的模型写下来，状态栏跟着变
  if (changed && stateLoaded) void saveState($).catch(() => {})
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
  // 换了模型就把这个窗口在用的模型写下来，状态栏跟着变
  if (stateLoaded) await saveState($)
  return c
}

// 译好的内容存在一个共享文件里，所有窗口、以及对话太长后续开的新会话都用它：
// 往回翻还是中文，同一段也不会翻两遍。按原文认，旧的先丢。
// 留这么多：500 条只够两三个小时，隔天再打开那个对话就全是英文了
const CACHE_KEEP_REPLIES = 5000
const CACHE_KEEP_SENT = 2000

type CacheEntry = { zh: string; cost?: number; at: number }
type Cache = { sent: Record<string, CacheEntry>; replies: Record<string, CacheEntry> }

async function cacheFile($: any): Promise<string> {
  return `${(await where($)).home}/.claude/zh-translate/cache.json`
}

async function readCache($: any): Promise<Cache> {
  try {
    const c = JSON.parse(await readText($, await cacheFile($)))
    return { sent: c.sent ?? {}, replies: c.replies ?? {} }
  } catch {
    return { sent: {}, replies: {} }
  }
}

// 新的在前，只留 keep 条
function prune(m: Record<string, CacheEntry>, keep: number): Record<string, CacheEntry> {
  const all = Object.entries(m)
  if (all.length <= keep) return m
  return Object.fromEntries(all.sort((a, b) => b[1].at - a[1].at).slice(0, keep))
}

// 共享的译文文件：一轮结束时写一次。它可能有几 MB，不必每译一段就重写一遍
async function saveCache($: any): Promise<void> {
  const now = await $.clock.now()
  const old = await readCache($)
  const sent: Record<string, CacheEntry> = { ...old.sent }
  for (const [en, zh] of Object.entries(await read($, sentAtom))) sent[en] = { zh, at: old.sent[en]?.at ?? now }
  const replies: Record<string, CacheEntry> = { ...old.replies }
  for (const [en, v] of Object.entries(await read($, repliesAtom))) if (v.zh) replies[en] = { zh: v.zh, cost: v.cost, at: old.replies[en]?.at ?? now }
  await $.fs.write(await cacheFile($), JSON.stringify({ sent: prune(sent, CACHE_KEEP_SENT), replies: prune(replies, CACHE_KEEP_REPLIES) }))
}

async function saveState($: any): Promise<void> {
  // 只属于这个会话的：问答框的回答、翻译累计，以及这个窗口真正在用的模型（状态栏读 using，
  // 旧版插件不写它，那它用的就是 Claude 的模型，状态栏不会跟着设置谎报成外部模型）
  await $.fs.write(await stateFile($), JSON.stringify({
    answered: await read($, answeredAtom),
    spent: await read($, spentAtom),
    using: currentName(await getConfig($)),
  }))
}

async function loadState($: any): Promise<void> {
  const cache = await readCache($)
  await update($, sentAtom, m => ({ ...Object.fromEntries(Object.entries(cache.sent).map(([k, v]) => [k, v.zh])), ...m }))
  await update($, repliesAtom, m => ({
    ...Object.fromEntries(Object.entries(cache.replies).map(([k, v]) => [k, { zh: v.zh, cost: v.cost ?? 0 }])),
    ...m,
  }))
  let s: { sent?: Record<string, string>; replies?: Record<string, Translation>; answered?: Record<string, AskAnswer>; spent?: number } = {}
  try { s = JSON.parse(await readText($, await stateFile($))) } catch {}
  // 0.5.0 之前译文存在会话文件里：一并收进来，下次保存就写进共享文件
  const oldSent = s.sent
  const oldReplies = s.replies
  if (oldSent) await update($, sentAtom, m => ({ ...oldSent, ...m }))
  if (oldReplies) await update($, repliesAtom, m => ({ ...oldReplies, ...m }))
  await update($, answeredAtom, m => ({ ...(s.answered ?? {}), ...m }))
  await update($, spentAtom, n => Math.max(n, s.spent ?? 0))
  stateLoaded = true
}

async function glossary($: any): Promise<string> {
  const pairs = (await readText($, `${(await where($)).home}/.claude/zh-translate/glossary.txt`)).split(/\r?\n/)
    .map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
  return pairs.length
    ? `\n- Glossary, one "Chinese = English" pair per line. Into Chinese, use the Chinese side where the English side (or a close variant) appears; into English, use the English side. Natural wording around a term is fine.\n${pairs.map(p => `  ${p}`).join('\n')}\n- Write the translation once. Never add notes, corrections or a second version.`
    : ''
}

// ---------- 翻译 ----------
type Done = { ok: true; text: string; cost: number; by: string } | { ok: false; reason: string; cost: number; by: string }

// 翻译模型没给出译文的原因，说成能看懂的话
function whyFailed(r: { reason: string; status?: number }): string {
  if (r.reason === 'empty-reply') return '翻译模型没有给出译文，可能是这段内容没通过它的安全检查'
  if (r.reason === 'aborted') return '翻译超时'
  if (r.reason === 'api-error') return `翻译接口出错${r.status ? `（${r.status}）` : ''}，可能是网络或服务暂时有问题`
  return r.reason
}

// 这次翻译交给谁：Claude 账号的某个模型，或外部 API 的某个模型
type Target = { kind: 'claude'; model: string } | { kind: 'api'; model: string }

async function completeClaude($: any, model: string, system: string, prompt: string, timeoutMs: number): Promise<Done> {
  const by = modelName(model)
  const r = await $.model.complete({ model, system, prompt, effort: 'low', maxTokens: 16000, timeoutMs })
  const cost = costOf(model, r.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  if (!r.isAnswered) return { ok: false, reason: whyFailed(r), cost, by }
  return { ok: true, text: r.text.replace(/^\s*<text>\s*|\s*<\/text>\s*$/g, '').trim(), cost, by }
}

async function completeApi($: any, api: ApiConfig, key: string, model: string, system: string, prompt: string): Promise<Done> {
  const by = apiName(api, model)
  const anthropic = api.format === 'anthropic'
  // 模型列表说支持 effort 的（DeepSeek）用低档：它默认会先想一大段，翻译用不着
  const low = api.models.find(m => m.id === model)?.effort
  const body = anthropic
    ? { model, system, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] }
    : { model, stream: false, max_tokens: 8192, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], ...(low ? { effort: 'low' } : {}) }
  let res: { ok: boolean; status: number; text: string }
  try {
    res = await $.http.fetch(endpoint(api, anthropic ? '/messages' : '/chat/completions'), { method: 'POST', headers: apiHeaders(api, key), body: JSON.stringify(body) })
  } catch (err) {
    return { ok: false, reason: `连不上翻译接口（${String((err as any)?.message ?? err).slice(0, 80)}）`, cost: 0, by }
  }
  if (!res.ok) return { ok: false, reason: apiError(res.status, res.text), cost: 0, by }
  try {
    const j = JSON.parse(res.text)
    const text = anthropic
      ? (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      : String(j.choices?.[0]?.message?.content ?? '')
    const used: [number, number] = anthropic
      ? [j.usage?.input_tokens ?? 0, j.usage?.output_tokens ?? 0]
      : [j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0]
    const [pi, po] = API_PRICES[model] ?? [0, 0]
    const cost = (used[0] * pi + used[1] * po) / 1e6
    if (!text.trim()) return { ok: false, reason: '翻译接口没有给出译文', cost, by }
    return { ok: true, text: text.replace(/^\s*<text>\s*|\s*<\/text>\s*$/g, '').trim(), cost, by }
  } catch {
    return { ok: false, reason: '翻译接口的回复看不懂', cost: 0, by }
  }
}

// 外部 API 出错时这一段改用 Claude 账号翻；提示一分钟最多一次，免得每段都弹
let fallbackToastAt = -Infinity

// 翻一段：设置成外部 API 且选好了模型就用它，出错改用 Claude 账号；only 指定了就只用它（试用新模型时）
async function translate($: any, system: string, ask: string, text: string, context = '', timeoutMs = 180000, only?: Target): Promise<Done> {
  const prompt = `${ask}\n\n${context ? `<context>\n${context.slice(0, 2000)}\n</context>\n\n` : ''}<text>\n${text}\n</text>`
  const c = await getConfig($)
  const target: Target = only ?? (c.provider === 'api' && c.api.model ? { kind: 'api', model: c.api.model } : { kind: 'claude', model: c.model })
  if (target.kind === 'claude') return completeClaude($, target.model, system, prompt, timeoutMs)
  const key = await apiKey($)
  const r = key ? await completeApi($, c.api, key, target.model, system, prompt) : ({ ok: false, reason: '还没填外部 API 的密钥', cost: 0, by: apiName(c.api, target.model) } as Done)
  if (r.ok || only) return r
  const now = await $.clock.now()
  if (now - fallbackToastAt > 60000) {
    fallbackToastAt = now
    $.ui.toast(`外部翻译接口出错，这段改用 Claude 翻译：${r.reason}`)
  }
  // 备用：改用 Claude 账号。记下真正出力的是谁，费用两边都算上
  const back = await completeClaude($, c.model, system, prompt, timeoutMs)
  const by = `${back.by}（备用）`
  const cost = back.cost + r.cost
  if (back.ok) return { ...back, cost, by }
  return { ok: false, cost, by, reason: `${back.reason}；${r.by} 先出错：${r.reason}` }
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
    r = await translate($, TO_ZH + (await glossary($)), ASK_ZH, mask(key, blocks, false), (await read($, turnAtom)).prompt)
  } catch (err) {
    // 请求没发出去（比如引擎拒绝）：记成没翻译，别一直显示“翻译中”
    r = { ok: false, reason: `翻译请求没有发出去（${String((err as any)?.message ?? err).slice(0, 80)}）`, cost: 0, by: '' }
  }
  await addSpent($, r.cost)
  const entry: Translation = r.ok ? { zh: unmask(r.text, blocks), cost: r.cost, by: r.by } : { error: r.reason, cost: r.cost, by: r.by }
  await update($, repliesAtom, m => ({ ...m, [key]: entry }))
  await saveState($)
}

// ---------- 问答框（AskUserQuestion） ----------
// 问答框每一题最多等它译这么久；超时的那一题照常显示英文
const ASK_TIMEOUT_MS = 20000

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

// 译一题；没译成返回 null（这一题照常显示英文）
async function translateQuestion($: any, q: AskQuestion): Promise<AskQuestion | null> {
  try {
    const texts = JSON.stringify(askTexts([q]), null, 1)
    const r = await translate($, TO_ZH + (await glossary($)), ASK_DIALOG, texts, (await read($, turnAtom)).prompt, ASK_TIMEOUT_MS)
    await addSpent($, r.cost)
    if (!r.ok) return null
    const json = r.text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')
    return askZh([q], JSON.parse(json))[0] ?? null
  } catch {
    return null
  }
}

// 问答框译成中文：一题一个请求，同时发（4 题的问答框整个一起译要 8 秒多，分开译 4 秒左右）。
// 一题都没译成返回 null（照常显示英文）
async function translateAsk($: any, qs: AskQuestion[]): Promise<AskQuestion[] | null> {
  const parts = await Promise.all(qs.map(q => translateQuestion($, q)))
  if (parts.every(p => !p)) return null
  const zh = parts.map((p, i) => p ?? qs[i]!)
  return new Set(zh.map(q => q.question)).size === zh.length ? zh : null
}

// 你在问答框里打的字：是中文就译成英文；没译成就照原样
async function answerEn($: any, text: string): Promise<string> {
  if (!CJK.test(text)) return text
  try {
    const blocks: string[] = []
    const r = await translate($, TO_EN + (await glossary($)), ASK_EN, mask(text, blocks, true))
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

// 获取外部 API 的模型列表，存进设置；返回给菜单显示的一句话
async function fetchApiModels($: any): Promise<string> {
  const c = await getConfig($)
  const key = await apiKey($)
  if (!key) return '先填密钥。'
  let res: { ok: boolean; status: number; text: string }
  try {
    res = await $.http.fetch(endpoint(c.api, '/models'), { headers: apiHeaders(c.api, key) })
  } catch (err) {
    return `连不上 ${c.api.url}（${String((err as any)?.message ?? err).slice(0, 80)}）`
  }
  if (!res.ok) return `获取模型列表失败：${apiError(res.status, res.text)}`
  let list: ApiModel[] = []
  try {
    list = (JSON.parse(res.text).data ?? []).map((m: any) => ({
      id: String(m.id),
      ...(m.name || m.display_name ? { name: String(m.name || m.display_name) } : {}),
      ...(m.effort?.supported_levels?.includes('low') ? { effort: true } : {}),
    }))
  } catch {}
  if (!list.length) return '这个服务没有给出模型列表，请在“模型 ID”里直接填。'
  await saveConfig($, { api: { ...c.api, models: list } })
  return `找到 ${list.length} 个模型，选一个就开始用它翻译。`
}

// 改用外部 API 的某个模型：先试译一个词，用不了就不换
async function useApiModel($: any, id: string): Promise<string> {
  const c = await getConfig($)
  const known = c.api.models.some(m => m.id === id)
  const api = known ? c.api : { ...c.api, models: [...c.api.models, { id }] }
  if (!known) await saveConfig($, { api })
  const r = await translate($, TO_EN, ASK_EN, '你好', '', 180000, { kind: 'api', model: id })
  await addSpent($, r.cost)
  if (!r.ok) return `“${apiName(api, id)}”用不了，没有更换（${r.reason}）`
  await saveConfig($, { provider: 'api', api: { ...api, model: id } })
  return `已改用外部 API 翻译：${apiName(api, id)}`
}

// /zh-model 列表的行数：Claude 的模型、外部 API 的模型（最多 12 个）、标题和按钮
const modelRows = (c: Config) => MODELS.length + Math.min(c.api.models.length, 12) + (c.api.models.length ? 1 : 0) + 4

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
  const r = await translate($, TO_EN, ASK_EN, '你好', '', 180000, { kind: 'claude', model: m })
  await addSpent($, r.cost)
  if (!r.ok) return `“${modelName(m)}”用不了，没有更换（${r.reason}）`
  await saveConfig($, { model: m, provider: 'claude' })
  return `翻译模型已改为 ${modelName(m)}（Claude 账号）`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive !== false
    await loadConfig($)
    await loadState($)
    await saveState($)
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
    else if (a === 'api') {
      const opened = await openPane($, API_PANE, '外部翻译 API', 26)
      return { text: opened ? '在菜单里选格式、填地址和密钥（回车保存），再选模型。' : '这里打不开菜单，请在交互界面里输入 /zh api 设置外部 API。' }
    }
    else if (a === 'api off') c = await saveConfig($, { provider: 'claude' })
    else if (a.startsWith('model ')) {
      const id = a.slice(6).trim()
      note = (c.api.models.some(m => m.id === id) ? await useApiModel($, id) : await switchModel($, id)) + '。'
      c = await getConfig($)
    }
    else note = `不认识“${a}”。`
    return { text: note + statusText(c, await read($, spentAtom)) }
  })

  on('command.run', { command: 'zh-model' }, async $ => {
    await syncConfig($)
    const opened = await openPane($, PANE, '翻译模型', modelRows(await getConfig($)))
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
      await openPane($, PANE, '翻译模型', modelRows(c))
    }
    const toApi = async () => {
      await $.ui.close({ id: SETTINGS })
      await openPane($, API_PANE, '外部翻译 API', 26)
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
        <Text bold>{`翻译模型：${currentName(c)}（${c.provider === 'api' ? '外部 API' : 'Claude 账号'}）`}</Text>
        <Box flexDirection="row" columnGap={2}>
          <Button key="model" hotkey="9" label="换模型…" onPress={toModels} />
          <Button key="api" hotkey="a" label="外部 API…" onPress={toApi} />
          <Button key="done" hotkey="0" role="dismiss" label="完成" onPress={() => $.ui.close({ id: SETTINGS })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await read($, configAtom)
    const onApi = c.provider === 'api' && !!c.api.model
    const cur = onApi ? '' : modelId(c.model)
    const run = async (label: string, change: () => Promise<string>) => {
      $.ui.toast(`正在检查 ${label}…`)
      const msg = await change()
      await $.ui.close({ id: PANE })
      $.ui.toast(msg)
    }
    const toApi = async () => {
      await $.ui.close({ id: PANE })
      await openPane($, API_PANE, '外部翻译 API', 26)
    }
    const ext = c.api.models.slice(0, 12)
    const host = c.api.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    return (
      <Box flexDirection="column">
        <Text dimColor>{`当前：${currentName(c)}。估价按一段约 70 词的回复算。`}</Text>
        <Text bold>你的 Claude 账号</Text>
        {MODELS.map((m, i) => (
          <Button
            key={m.id}
            hotkey={HOTKEYS[i]}
            variant={m.id === cur ? 'primary' : undefined}
            label={`${m.name}${m.id === cur ? '（当前）' : ''} · ${m.speed} · ${eachCost(m.id, false)}`}
            onPress={() => run(m.name, () => switchModel($, m.id))}
          />
        ))}
        {ext.length ? <Text bold>{`外部 API（${host}）`}</Text> : null}
        {ext.map((m, i) => {
          const isCur = onApi && c.api.model === m.id
          return (
            <Button
              key={`api-${m.id}`}
              hotkey={HOTKEYS[MODELS.length + i]}
              variant={isCur ? 'primary' : undefined}
              label={`${m.name ?? m.id}${isCur ? '（当前）' : ''} · ${eachCost(m.id, true)}`}
              onPress={() => run(m.name ?? m.id, () => useApiModel($, m.id))}
            />
          )
        })}
        <Button key="api" hotkey="0" label={ext.length ? '外部 API 设置…' : '用外部 API（DeepSeek 等）…'} onPress={toApi} />
      </Box>
    )
  })

  // 外部 API 设置：格式、地址、密钥（只显示头尾）、模型列表；选模型前先试译
  on('ui.render', { component: 'Pane', requestId: API_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // 手机、VS Code 这类界面没有输入框：提示到终端里设置
    const Input = 'Input' in ui ? ui.Input : null
    const c = await read($, configAtom)
    const note = await read($, apiNoteAtom)
    const key = await apiKey($)
    const say = (s: string) => update($, apiNoteAtom, () => s)
    const setFormat = (format: ApiConfig['format']) => async () => {
      if (format === c.api.format) return
      const url = format === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com'
      await saveConfig($, { api: { format, url, model: '', models: [] }, ...(c.provider === 'api' ? { provider: 'claude' } : {}) })
      await say('格式已改，请确认地址并获取模型列表。')
    }
    const saveUrl = async (v: string) => {
      const url = v.trim()
      if (!/^https?:\/\/\S+$/.test(url)) return void (await say('地址要以 http:// 或 https:// 开头。'))
      await saveConfig($, { api: { ...c.api, url, model: '', models: [] }, ...(c.provider === 'api' ? { provider: 'claude' } : {}) })
      await say(key ? await fetchApiModels($) : '地址已保存，再填密钥。')
    }
    const saveKey = async (v: string) => {
      const k = v.trim()
      if (!k) return
      await $.fs.write(await keyFile($), k)
      await say(`密钥已保存（${maskKey(k)}）。${await fetchApiModels($)}`)
    }
    const pick = async (id: string) => {
      await say(`正在试用 ${apiName(c.api, id)}…`)
      await say(await useApiModel($, id))
    }
    const back = async () => {
      await saveConfig($, { provider: 'claude' })
      await say(`已改回 Claude 账号翻译（${modelName(c.model)}）。`)
    }
    const models = c.api.models.slice(0, 12)
    return (
      <Box flexDirection="column">
        <Text dimColor>注意：要翻译的内容（你的消息、Claude 的回复，可能有代码、服务器地址、密码）会发给这个服务。</Text>
        <Text bold>接口格式</Text>
        <Box flexDirection="row" columnGap={2}>
          <Button key="fmt-openai" hotkey="1" variant={c.api.format === 'openai' ? 'primary' : undefined} label={`${c.api.format === 'openai' ? '●' : '○'} OpenAI 兼容（DeepSeek、通义千问、Kimi 等）`} onPress={setFormat('openai')} />
          <Button key="fmt-anthropic" hotkey="2" variant={c.api.format === 'anthropic' ? 'primary' : undefined} label={`${c.api.format === 'anthropic' ? '●' : '○'} Anthropic`} onPress={setFormat('anthropic')} />
        </Box>
        {Input ? <Input key="url" label="地址 " value={c.api.url} placeholder="https://api.deepseek.com" submitLabel="保存" onSubmit={saveUrl} /> : <Text>{`地址：${c.api.url}`}</Text>}
        {Input ? <Input key="key" label="密钥 " value="" placeholder={key ? `已保存 ${maskKey(key)}，粘贴新的可替换` : '粘贴密钥后回车'} submitLabel="保存" onSubmit={saveKey} /> : <Text>{`密钥：${key ? maskKey(key) : '未填'}（这个界面不能输入，请在终端里用 /zh api 填写）`}</Text>}
        <Box flexDirection="row" columnGap={2}>
          <Button key="fetch" hotkey="3" label="获取模型列表" onPress={async () => say(await fetchApiModels($))} />
          {c.provider === 'api' ? <Button key="back" hotkey="4" label="改回 Claude 账号" onPress={back} /> : null}
          <Button key="done" hotkey="0" role="dismiss" label="完成" onPress={() => $.ui.close({ id: API_PANE })} />
        </Box>
        {models.length ? <Text bold>模型（选一个先试译，能用就换上）</Text> : null}
        {models.map((m, i) => {
          const cur = c.provider === 'api' && c.api.model === m.id
          return (
            <Button
              key={`m-${m.id}`}
              hotkey={HOTKEYS[i + 4]}
              variant={cur ? 'primary' : undefined}
              label={`${m.name ?? m.id}${cur ? '（正在用）' : ''} · ${eachCost(m.id, true)}`}
              onPress={() => pick(m.id)}
            />
          )
        })}
        {Input ? <Input key="model-id" label="模型 ID " value="" placeholder="列表里没有的模型，填 ID 后回车" submitLabel="试用" onSubmit={(v: string) => (v.trim() ? pick(v.trim()) : undefined)} /> : null}
        {note ? <Text>{note}</Text> : null}
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
    // 只有截图、粘贴内容（没有你自己的话），或者只回了 OK、yes 这样一两个英文词：
    // 沿用上一条的语言，不当成英文对话；上一条是中文，回复照样翻
    const words = text.replace(PLACEHOLDER, '').trim()
    const ack = words.length <= 12 && words.split(/\s+/).length <= 2
    if (c.enabled && !CJK.test(words) && (!/[A-Za-z]/.test(words) || ack)) {
      const turn = await update($, turnAtom, t => ({ ...t, finalTexts: [] }))
      return next(turn.zh ? { ...e, context: [...(e.context ?? []), REPLY_EN] } : e)
    }
    if (!c.enabled || !CJK.test(text)) {
      await update($, turnAtom, () => ({ zh: false, prompt: '', finalTexts: [] }))
      return next(e)
    }
    await update($, turnAtom, () => ({ zh: true, prompt: text, finalTexts: [] }))
    const blocks: string[] = []
    const r = await translate($, TO_EN + (await glossary($)), ASK_EN, mask(text, blocks, true))
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
    // 这一轮译好的内容写进共享文件，别的窗口和以后重开这个对话都能用
    await saveCache($)
    return done
  })

  // ---------- 问答框（AskUserQuestion） ----------
  // 先译好再弹出，问答框直接以中文显示（弹出后再换内容，引擎不会重画问答框）。
  // 等的是翻译请求，不占钩子的时间预算。你答完后，回答以英文交给 Claude
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined || e.tool !== 'AskUserQuestion') return next(e)
    const c = await getConfig($)
    if (!c.enabled || !(await read($, turnAtom)).zh) return next(e)
    const en = e.questions as unknown as AskQuestion[]
    $.ui.toast('正在把问答框译成中文…')
    const zh = await translateAsk($, en)
    const done = await next(zh ? { ...e, questions: zh as any } : e)
    if (done.deny !== undefined || done.isError) return done
    const shown = zh ?? en
    const r = done.result as unknown as AskAnswer
    const enAnswer = await askAnswerEn($, en, shown, r)
    await update($, answeredAtom, m => ({ ...m, [e.tool_use_id]: askAnswerShown(en, shown, r) }))
    await saveState($)
    return { result: enAnswer as any, ...(done.context ? { context: done.context } : {}) }
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
    if (!tr.zh) return next({ ...e, props: { ...e.props, text: `${e.props.text}\n\n*（这一段没有翻译，上面是英文原文。原因：${tr.by ? tr.by + ' ' : ''}${tr.error}）*` } })
    // 关了“显示翻译费用”就不写金额；both 模式的分隔线照留
    const cost = c.showCost ? `本条 ${tr.by ? tr.by + ' ' : ''}${usd(tr.cost)} · 本会话翻译累计 ${usd(await read($, spentAtom))}` : ''
    const text = c.mode === 'both'
      ? `${e.props.text}\n\n───── 中文 ─────${cost ? ` ${cost}` : ''}\n\n${tr.zh}`
      : cost ? `${tr.zh}\n\n*（翻译费用：${cost}）*` : tr.zh
    return next({ ...e, props: { ...e.props, text } })
  })
}
