// zh-translate 的测试：引擎下面的文件、进程、模型调用都换成假的，翻译结果加前缀，好断言
import { expect, test } from 'claude-code/testing'

type Seen = { submitted?: { text: string; context?: readonly string[] }; asks: string[]; closed: string[]; toasts: string[]; opened?: string[] }

const HOME = '/h'
const TMP = '/t'
// 引擎会把 /h/... 规整成本机的写法（Windows 上是 C:\h\...），文件表统一按去掉盘符的 / 路径存
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const CONFIG = norm(`${HOME}/.claude/zh-translate/config.json`)

type Fakes = { failModel?: boolean; systems?: string[]; noPane?: boolean }

// 引擎的服务调用（文件、进程、模型……）在测试里回答成 { value }；同一事件一个测试只能挂一次
function fake(on: any, files: Record<string, string>, seen: Seen, opts: Fakes = {}) {
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ home: HOME, tmp: TMP }), stderr: '', isStdoutTruncated: false } }))
  on('fs.read', ($: any, e: any) => {
    const p = norm(e.path)
    return p in files ? { value: files[p] } : { deny: `ENOENT ${p}` }
  })
  on('fs.write', ($: any, e: any) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('ui.toast', ($: any, e: any) => {
    seen.toasts.push(String(e.text ?? ''))
    return { value: undefined }
  })
  on('ui.open', ($: any, e: any) => {
    if (opts.noPane) return { deny: 'no surface' }
    ;(seen.opened ??= []).push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: any, e: any) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('model.complete', ($: any, e: any) => {
    seen.asks.push(e.prompt)
    opts.systems?.push(e.system)
    const usage0 = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (opts.failModel) return { value: { isAnswered: false, reason: 'api-error', status: 529, usage: usage0 } }
    const body = /<text>\n([\s\S]*)\n<\/text>/.exec(e.prompt)?.[1] ?? ''
    const toEn = e.prompt.startsWith('Translate the Chinese')
    return {
      value: {
        isAnswered: true,
        text: (toEn ? 'EN: ' : '中文：') + body,
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('prompt.submit', ($: any, e: any) => {
    seen.submitted = { text: e.text, context: e.context }
    return { text: e.text, context: e.context }
  })
  // 测试里下面没有真的存储：存下即可（插件的钩子先跑完，这里收尾）
  on('session.append', ($: any, e: any) => ({ message: e.message, uuid: e.uuid }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  // 引擎自己画消息的地方：把最后拿到的 props.text 画成一个 Text
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => ({ type: 'Text', props: {}, children: [e.props.text] }))
}

const textOf = (tree: unknown) => JSON.stringify(tree)

// 测试里没有真的存储，存的那一步可能报错；插件的钩子在它之前已经跑完
async function append($: any, message: unknown, uuid: string) {
  try {
    await $.session.append({ message, door: 'response', origin: { kind: 'model', model: 'claude-opus-5-5' }, uuid })
  } catch {}
}

const reply = ($: any, text: string, uuid: string) =>
  append($, { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, uuid)

const toolCall = ($: any, uuid: string) =>
  append($, { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: `tool-${uuid}`, name: 'Bash', input: { command: 'ls' } }] }, uuid)

// 后台翻译不在调用里等完，反复读几次画面直到出现 want
async function drawnUntil(m: any, want: string): Promise<string> {
  let t = ''
  for (let i = 0; i < 200; i++) {
    t = textOf(await m.drawn())
    if (t.includes(want)) return t
  }
  return t
}

function mountReply($: any, text: string, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'zh-translate', surface, component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
}

test('中文消息只以英文发给 Claude，你那一行显示中文和发出去的英文', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  await $.prompt.submit({ text: '把"重试"按钮改成红色', wait: false, origin: { kind: 'composer' } })
  expect(seen.submitted?.text).toBe('EN: 把"重试"按钮改成红色')
  expect(seen.submitted?.context?.some(c => c.startsWith('Write your reply in English'))).toBe(true)
  // 译文请求本身要求“翻译，不要回答”
  expect(seen.asks[0]?.startsWith('Translate the Chinese text inside <text> into English')).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({
      plugin: 'zh-translate', surface, component: 'UserMessage',
      props: { text: 'EN: 把"重试"按钮改成红色', origin: { kind: 'composer' }, isExpanded: false },
    })
    const shown = textOf(await row.drawn())
    expect(shown.includes('把\\"重试\\"按钮改成红色')).toBe(true)
    expect(shown.includes('↳ EN: ')).toBe(true)
  }
})

test('英文消息原样发送，回复也不翻译', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  await $.prompt.submit({ text: 'list the files', wait: false, origin: { kind: 'composer' } })
  expect(seen.submitted?.text).toBe('list the files')
  await reply($, 'There are two files here.', 'r0')
  const m = await mountReply($, 'There are two files here.')
  expect(textOf(await m.drawn()).includes('中文：')).toBe(false)
  expect(seen.asks.length).toBe(0)
})

test('回复写完就翻译，only 只显示中文，/zh both 后屏幕上已有的回复立刻附上中文', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  await $.prompt.submit({ text: '帮我看看日志', wait: false, origin: { kind: 'composer' } })
  const en = 'I checked the logs and found a timeout.\n\n```\nERR timeout\n```'
  await reply($, en, 'r1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const m = await mountReply($, en, surface)
    const only = await drawnUntil(m, '中文：')
    expect(only.includes('中文：I checked the logs')).toBe(true)
    expect(only.includes('翻译费用')).toBe(true)
  }
  // 代码块没有送去翻译（请求里是占位符），译文里原样放回
  expect(seen.asks.some(a => a.includes('ERR timeout'))).toBe(false)
  const m = await mountReply($, en)
  expect((await drawnUntil(m, 'ERR timeout')).includes('ERR timeout')).toBe(true)

  const r = await $.command.run({ command: 'zh', args: 'both', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(String(r.text).includes('英文下面附中文')).toBe(true)
  const both = textOf(await m.drawn())
  expect(both.includes('I checked the logs and found a timeout.')).toBe(true)
  expect(both.includes('───── 中文 ─────')).toBe(true)
  expect(JSON.parse(files[CONFIG] ?? '{}').mode).toBe('both')
})

test('/zh final：中间过程不翻译，只在一轮结束时翻最后的回复', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  await $.command.run({ command: 'zh', args: 'final', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await $.prompt.submit({ text: '列出文件', wait: false, origin: { kind: 'composer' } })
  const asksAfterPrompt = seen.asks.length
  await reply($, 'Let me list the files.', 'w1')
  await toolCall($, 'w2')
  await reply($, 'There are two files.', 'w3')

  // 一轮还没结束：一条回复都没翻
  expect(seen.asks.length).toBe(asksAfterPrompt)
  await $.turn.complete({ answer: 'There are two files.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })

  const last = await mountReply($, 'There are two files.')
  expect((await drawnUntil(last, '中文：')).includes('中文：There are two files.')).toBe(true)
  const working = await mountReply($, 'Let me list the files.')
  expect(textOf(await working.drawn()).includes('中文：')).toBe(false)
  expect(seen.asks.filter(a => a.startsWith('Translate the English')).length).toBe(1)
})

test('/zh-model 列出模型，选一个就试译、保存并关掉', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  const pane = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'Pane', requestId: 'zh-model', props: { title: '翻译模型' } })
  const buttons = await pane.findAll({ type: 'Button' })
  expect(buttons.length).toBe(11)
  await pane.press({ key: 'claude-haiku-4-5' })
  expect(JSON.parse(files[CONFIG] ?? '{}').model).toBe('claude-haiku-4-5')
  expect(seen.closed.includes('zh-model')).toBe(true)
  expect(seen.toasts.some(t => t.includes('Haiku 4.5'))).toBe(true)
})

// ---------- 第二轮：出错、关闭、恢复会话、词表、日志 ----------

test('翻译失败：中文原样发出并提示；回复显示失败说明，不会丢内容', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen, { failModel: true })

  await $.prompt.submit({ text: '帮我看看', wait: false, origin: { kind: 'composer' } })
  expect(seen.submitted?.text).toBe('帮我看看')
  expect(seen.submitted?.context?.some(c => c.startsWith('Write your reply in English'))).toBe(true)
  expect(seen.toasts.some(t => t.includes('翻译失败'))).toBe(true)

  await reply($, 'Here is the answer.', 'f1')
  const m = await mountReply($, 'Here is the answer.')
  const shown = await drawnUntil(m, '中文翻译失败')
  expect(shown.includes('Here is the answer.')).toBe(true)
  expect(shown.includes('中文翻译失败')).toBe(true)
})

test('/zh off：中文原样发送，回复不翻译', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  const r = await $.command.run({ command: 'zh', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(String(r.text).includes('已关闭')).toBe(true)
  await $.prompt.submit({ text: '帮我看看', wait: false, origin: { kind: 'composer' } })
  expect(seen.submitted?.text).toBe('帮我看看')
  await reply($, 'Here is the answer.', 'o1')
  const m = await mountReply($, 'Here is the answer.')
  expect(textOf(await m.drawn()).includes('中文')).toBe(false)
  expect(seen.asks.length).toBe(0)
})

test('恢复会话：存下的翻译在重新载入后照样显示', async ($: any, on: any) => {
  const files: Record<string, string> = {
    [norm(`${TMP}/claude-zh/plugin-state-sess-1.json`)]: JSON.stringify({
      sent: { 'EN: 你好': '你好' },
      replies: { 'Hello there.': { zh: '你好呀。', cost: 0.001 } },
      spent: 0.002,
    }),
  }
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  fake(on, files, seen)

  try { await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true }) } catch {}
  const row = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'UserMessage', props: { text: 'EN: 你好', origin: { kind: 'composer' }, isExpanded: false } })
  expect(textOf(await row.drawn()).includes('你好')).toBe(true)
  const m = await mountReply($, 'Hello there.')
  expect(textOf(await m.drawn()).includes('你好呀。')).toBe(true)
  expect(seen.asks.length).toBe(0)
})

test('词表进了翻译要求；粘贴的日志原样发给 Claude', async ($: any, on: any) => {
  const files: Record<string, string> = {
    [norm(`${HOME}/.claude/zh-translate/glossary.txt`)]: '# 注释\n老板号 = boss account\n',
  }
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  const systems: string[] = []
  fake(on, files, seen, { systems })

  const text = '老板号登录报错，日志如下：\nError: session taken over (code 8)\n    at Login.handle (login.go:212)\n怎么办'
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  expect(systems[0]?.includes('老板号 = boss account')).toBe(true)
  // 日志行没送去翻译，发给 Claude 的英文里原样带着
  expect(seen.asks[0]?.includes('session taken over')).toBe(false)
  expect(seen.submitted?.text.includes('Error: session taken over (code 8)\n    at Login.handle (login.go:212)')).toBe(true)
})

// ---------- 第三轮：/zh 设置菜单 ----------

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

test('/zh 不带参数打开设置菜单；带参数照旧直接切换', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  const r = await $.command.run({ command: 'zh', args: '', ...RUN })
  expect(seen.opened?.includes('zh-settings')).toBe(true)
  expect(String(r.text).includes('上下键')).toBe(true)
  const r2 = await $.command.run({ command: 'zh', args: 'both', ...RUN })
  expect(String(r2.text).includes('英文下面附中文')).toBe(true)
  expect(seen.opened?.length).toBe(1)
})

test('设置菜单：按下就生效并保存，当前项标 ●；换模型跳到模型列表；完成关闭', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  const desk = await $.ui.mount({ plugin: 'zh-translate', surface: 'desktop', component: 'Pane', requestId: 'zh-settings', props: { title: '中文翻译设置' } })
  expect((await desk.findAll({ type: 'Button' })).length).toBe(8)
  const pane = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'Pane', requestId: 'zh-settings', props: { title: '中文翻译设置' } })
  expect((await pane.findAll({ type: 'Button' })).length).toBe(8)
  const label = async (key: string) => String((await pane.find({ key }))?.props?.label ?? JSON.stringify(await pane.find({ key })))
  expect((await label('only')).includes('●')).toBe(true)
  expect((await label('both')).includes('○')).toBe(true)

  await pane.press({ key: 'both' })
  expect(JSON.parse(files[CONFIG] ?? '{}').mode).toBe('both')
  expect((await label('both')).includes('●')).toBe(true)
  expect((await label('only')).includes('○')).toBe(true)

  await pane.press({ key: 'final' })
  expect(JSON.parse(files[CONFIG] ?? '{}').scope).toBe('final')
  await pane.press({ key: 'off' })
  expect(JSON.parse(files[CONFIG] ?? '{}').enabled).toBe(false)
  expect((await label('off')).includes('●')).toBe(true)
  await pane.press({ key: 'on' })
  expect(JSON.parse(files[CONFIG] ?? '{}').enabled).toBe(true)

  await pane.press({ key: 'model' })
  expect(seen.closed.includes('zh-settings')).toBe(true)
  expect(seen.opened?.includes('zh-model')).toBe(true)

  seen.closed = []
  await pane.press({ key: 'done' })
  expect(seen.closed.includes('zh-settings')).toBe(true)
})

test('没有界面可画（claude -p）：/zh 回状态文字，/zh-model 提示用文字命令', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen, { noPane: true })

  const r = await $.command.run({ command: 'zh', args: '', ...RUN })
  expect(String(r.text).includes('中文翻译已开启')).toBe(true)
  const m = await $.command.run({ command: 'zh-model', args: '', ...RUN })
  expect(String(m.text).includes('/zh model')).toBe(true)
})

test('非交互会话（claude -p）：/zh 直接回状态文字，不去开菜单', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  fake(on, files, seen)

  try { await $.session.start({ cwd: '/w', surface: null, isInteractive: false }) } catch {}
  const r = await $.command.run({ command: 'zh', args: '', ...RUN })
  expect(String(r.text).includes('中文翻译已开启')).toBe(true)
  expect(seen.opened ?? []).toEqual([])
})
