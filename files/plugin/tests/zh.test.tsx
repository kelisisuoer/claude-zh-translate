// zh-translate 的测试：引擎下面的文件、进程、模型调用都换成假的，翻译结果加前缀，好断言
import { expect, mock, test } from 'claude-code/testing'

type Seen = { submitted?: { text: string; context?: readonly string[] }; asks: string[]; closed: string[]; toasts: string[]; opened?: string[] }

const HOME = '/h'
const TMP = '/t'
// 引擎会把 /h/... 规整成本机的写法（Windows 上是 C:\h\...），文件表统一按去掉盘符的 / 路径存
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const CONFIG = norm(`${HOME}/.claude/zh-translate/config.json`)

// 假文件的修改时间：写一次加一，没写过的算 1
const mtimes: Record<string, number> = {}
let tick = 1

type Fakes = { failModel?: boolean | 'empty' | 'throw'; badDialog?: boolean | string; slowDialog?: number; dialogTimeouts?: number[]; systems?: string[]; noPane?: boolean }

// 引擎的服务调用（文件、进程、模型……）在测试里回答成 { value }；同一事件一个测试只能挂一次
function fake(on: any, files: Record<string, string>, seen: Seen, opts: Fakes = {}) {
  const clock = mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ home: HOME, tmp: TMP }), stderr: '', isStdoutTruncated: false } }))
  on('fs.read', ($: any, e: any) => {
    const p = norm(e.path)
    return p in files ? { value: files[p] } : { deny: `ENOENT ${p}` }
  })
  on('fs.write', ($: any, e: any) => {
    files[norm(e.path)] = e.text
    mtimes[norm(e.path)] = ++tick
    return { value: undefined }
  })
  on('fs.stat', ($: any, e: any) => {
    const p = norm(e.path)
    return p in files ? { value: { kind: 'file', size: files[p]!.length, mtimeMs: mtimes[p] ?? 1, isLink: false } } : { deny: `ENOENT ${p}` }
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
  on('model.complete', async ($: any, e: any) => {
    seen.asks.push(e.prompt)
    opts.systems?.push(e.system)
    const usage0 = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (opts.failModel === 'throw') return { deny: 'model blocked' }
    if (opts.failModel === 'empty') return { value: { isAnswered: false, reason: 'empty-reply', usage: usage0 } }
    if (opts.failModel) return { value: { isAnswered: false, reason: 'api-error', status: 529, usage: usage0 } }
    const body = /<text>\n([\s\S]*)\n<\/text>/.exec(e.prompt)?.[1] ?? ''
    // 问答框：JSON 里每个值加“中”
    if (e.prompt.startsWith('The JSON object')) {
      opts.dialogTimeouts?.push(e.timeoutMs)
      if (opts.slowDialog) await clock.sleep(opts.slowDialog)
      const o = JSON.parse(body) as Record<string, string>
      const bad = opts.badDialog === true || (typeof opts.badDialog === 'string' && body.includes(opts.badDialog))
      const text = bad ? '好的，这是翻译：' : JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, '中' + v])))
      return { value: { isAnswered: true, text, usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
    }
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
  // 存消息交给下面的引擎（Claude Code 2.1.292 起测试工具要求传下去，不能自己回答）
  on('session.append', ($: any, e: any, next: any) => next(e))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  // 引擎自己画消息的地方：把最后拿到的 props.text 画成一个 Text
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  on('ui.render', { component: 'ToolResult' }, ($: any, e: any) => ({ type: 'Text', props: {}, children: [JSON.stringify(e.props.output)] }))
  return clock
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
  expect(seen.toasts.some(t => t.includes('这条没有翻译') && t.includes('翻译接口出错（529）'))).toBe(true)

  await reply($, 'Here is the answer.', 'f1')
  const m = await mountReply($, 'Here is the answer.')
  const shown = await drawnUntil(m, '这一段没有翻译')
  expect(shown.includes('Here is the answer.')).toBe(true)
  expect(shown.includes('这一段没有翻译，上面是英文原文')).toBe(true)
  expect(shown.includes('翻译接口出错（529）')).toBe(true)
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
  expect((await desk.findAll({ type: 'Button' })).length).toBe(10)
  const pane = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'Pane', requestId: 'zh-settings', props: { title: '中文翻译设置' } })
  expect((await pane.findAll({ type: 'Button' })).length).toBe(10)
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

// ---------- 第四轮：显示 / 不显示翻译费用 ----------

test('关掉显示费用：回复、菜单、状态文字都不显示金额；both 模式的分隔线照留；打开后恢复', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  await $.prompt.submit({ text: '帮我看看日志', wait: false, origin: { kind: 'composer' } })
  const en = 'The log shows a timeout.'
  await reply($, en, 'c1')
  const m = await mountReply($, en)
  expect((await drawnUntil(m, '翻译费用')).includes('翻译费用')).toBe(true)

  const off = await $.command.run({ command: 'zh', args: 'cost off', ...RUN })
  expect(String(off.text).includes('不显示费用')).toBe(true)
  expect(String(off.text).includes('$')).toBe(false)
  expect(JSON.parse(files[CONFIG] ?? '{}').showCost).toBe(false)
  const only = textOf(await m.drawn())
  expect(only.includes('中文：The log shows a timeout.')).toBe(true)
  expect(only.includes('翻译费用')).toBe(false)
  expect(only.includes('$')).toBe(false)

  await $.command.run({ command: 'zh', args: 'both', ...RUN })
  const both = textOf(await m.drawn())
  expect(both.includes('───── 中文 ─────')).toBe(true)
  expect(both.includes('本条')).toBe(false)

  const pane = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'Pane', requestId: 'zh-settings', props: { title: '中文翻译设置' } })
  const menu = textOf(await pane.drawn())
  expect(menu.includes('本会话翻译累计')).toBe(false)
  expect(String((await pane.find({ key: 'cost-off' }))?.props?.label).includes('●')).toBe(true)

  await pane.press({ key: 'cost-on' })
  expect(JSON.parse(files[CONFIG] ?? '{}').showCost).toBe(true)
  expect(textOf(await m.drawn()).includes('本条')).toBe(true)
  expect(textOf(await pane.drawn()).includes('本会话翻译累计')).toBe(true)
})

test('翻译模型没给译文（empty-reply）：说明可能是没通过安全检查，显示英文原文', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen, { failModel: 'empty' })

  await $.prompt.submit({ text: '帮我看看', wait: false, origin: { kind: 'composer' } })
  expect(seen.toasts.some(t => t.includes('安全检查'))).toBe(true)
  await reply($, 'Here is the answer.', 'e1')
  const m = await mountReply($, 'Here is the answer.')
  const shown = await drawnUntil(m, '安全检查')
  expect(shown.includes('Here is the answer.')).toBe(true)
  expect(shown.includes('翻译模型没有给出译文，可能是这段内容没通过它的安全检查')).toBe(true)
  expect(shown.includes('empty-reply')).toBe(false)
})

test('/zh 和 /zh-model 注册成 immediate：Claude 回复中途输入也立刻弹出，不用等这一轮结束', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  const regs: any[] = []
  on('command.register', ($: any, e: any) => { regs.push(e); return { value: { command: e.name } } })
  fake(on, files, seen)

  try { await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true }) } catch {}
  expect(regs.map(r => r.name).sort()).toEqual(['zh', 'zh-model'])
  expect(regs.every(r => r.immediate === true)).toBe(true)
})

// ---------- 第五轮：设置对所有窗口生效 ----------

test('别的窗口改了设置：2 秒内这个窗口跟着变，已经显示的回复重画', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  const clock = fake(on, files, seen)
  try { await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true }) } catch {}

  await $.prompt.submit({ text: '帮我看看日志', wait: false, origin: { kind: 'composer' } })
  const en = 'The log shows a timeout.'
  await reply($, en, 'g1')
  const m = await mountReply($, en)
  expect((await drawnUntil(m, '翻译费用')).includes('翻译费用')).toBe(true)

  // 另一个窗口用 /zh 关掉了费用显示：设置文件变了
  files[CONFIG] = JSON.stringify({ ...JSON.parse(files[CONFIG] ?? '{}'), showCost: false })
  mtimes[CONFIG] = ++tick
  await clock.advance(1000)
  expect(textOf(await m.drawn()).includes('翻译费用')).toBe(true)
  await clock.advance(1000)
  const after = textOf(await m.drawn())
  expect(after.includes('中文：The log shows a timeout.')).toBe(true)
  expect(after.includes('翻译费用')).toBe(false)

  // 再打开：同样跟着变
  files[CONFIG] = JSON.stringify({ ...JSON.parse(files[CONFIG]!), showCost: true })
  mtimes[CONFIG] = ++tick
  await clock.advance(2000)
  expect(textOf(await m.drawn()).includes('翻译费用')).toBe(true)
})

test('在这个窗口的菜单里改设置，不会把别的窗口刚改的设置盖回去', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  const pane = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'Pane', requestId: 'zh-settings', props: { title: '中文翻译设置' } })
  await pane.press({ key: 'both' })
  expect(JSON.parse(files[CONFIG]!).mode).toBe('both')

  // 菜单还开着，另一个窗口关掉了费用显示、换了模型
  files[CONFIG] = JSON.stringify({ ...JSON.parse(files[CONFIG]!), showCost: false, model: 'claude-haiku-4-5' })
  mtimes[CONFIG] = ++tick
  await pane.press({ key: 'final' })
  const saved = JSON.parse(files[CONFIG]!)
  expect(saved.mode).toBe('both')
  expect(saved.scope).toBe('final')
  expect(saved.showCost).toBe(false)
  expect(saved.model).toBe('claude-haiku-4-5')
  // 这个窗口的菜单也显示别的窗口改的结果
  expect(String((await pane.find({ key: 'cost-off' }))?.props?.label).includes('●')).toBe(true)
})

// ---------- 第六轮：卡在“翻译中” ----------

test('插件重载时没译完的回复：新载入的插件重新译，不会一直显示“翻译中”', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  // 模拟重载：先开始的那两次翻译属于重载前的那一份插件，它们的译文永远写不进来，只剩“翻译中”的标记
  // （第一段的标记是重载前那份插件的，第二段是旧版本写的，没有 owner）
  let reloaded = false
  on('state.set', async ($: any, e: any, next: any) => {
    if (e.key !== 'replies' || reloaded) return next(e)
    const value = Object.fromEntries(Object.entries(e.value as Record<string, any>).map(([k, v]) =>
      [k, k.includes('older') ? { pending: true, cost: 0 } : { pending: true, owner: 'old-load', cost: 0 }]))
    return next({ ...e, value })
  })
  fake(on, files, seen)

  await $.prompt.submit({ text: '帮我看看', wait: false, origin: { kind: 'composer' } })
  await reply($, 'The answer was cut off.', 'k1')
  await reply($, 'Written by an older version.', 'k2')
  const m = await mountReply($, 'The answer was cut off.')
  const m2 = await mountReply($, 'Written by an older version.')
  expect(textOf(await m.drawn()).includes('翻译中')).toBe(true)
  expect(textOf(await m2.drawn()).includes('翻译中')).toBe(true)

  // 新载入的插件：session.start 把没译完的重新译
  reloaded = true
  try { await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true }) } catch {}
  const shown = await drawnUntil(m, '中文：The answer was cut off.')
  expect(shown.includes('中文：The answer was cut off.')).toBe(true)
  expect(shown.includes('翻译中')).toBe(false)
  const shown2 = await drawnUntil(m2, '中文：Written by an older version.')
  expect(shown2.includes('中文：Written by an older version.')).toBe(true)
  expect(shown2.includes('翻译中')).toBe(false)
})

test('正在译的回复不会被重复译', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  await $.prompt.submit({ text: '帮我看看', wait: false, origin: { kind: 'composer' } })
  const asked = seen.asks.length
  await reply($, 'Same paragraph.', 'd1')
  await reply($, 'Same paragraph.', 'd2')
  const m = await mountReply($, 'Same paragraph.')
  await drawnUntil(m, '中文：Same paragraph.')
  expect(seen.asks.length - asked).toBe(1)
})

test('翻译请求没发出去（引擎拒绝）：显示没有翻译的原因，不会一直显示“翻译中”', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen, { failModel: 'throw' })

  await $.prompt.submit({ text: '帮我看看', wait: false, origin: { kind: 'composer' } })
  await reply($, 'Here is the answer.', 't1')
  const m = await mountReply($, 'Here is the answer.')
  const shown = await drawnUntil(m, '这一段没有翻译')
  expect(shown.includes('这一段没有翻译')).toBe(true)
  expect(shown.includes('翻译请求没有发出去')).toBe(true)
  expect(shown.includes('翻译中')).toBe(false)
})

// ---------- 第七轮：问答框（AskUserQuestion） ----------

const QUESTIONS = [
  { question: 'Which approach?', header: 'Approach', multiSelect: false, options: [{ label: 'Retry', description: 'Try the call again' }, { label: 'Skip' }] },
  { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Tests' }, { label: 'Types' }] },
]

// 引擎这边的问答框：问答框只能由引擎自己画（插件只能改它拿到的问题），这里记下引擎拿到的问题；
// 弹出后等中文出现（waitFor），然后按 answer 回答
function dialog(on: any, $: any, seen: { drawn: string; id: string; input?: string }, answer: (e: any) => any, waitFor = '') {
  on('ui.render', { component: 'AskUserQuestion' }, (_: any, e: any) => {
    seen.drawn = JSON.stringify(e.props.questions)
    return { type: 'engine', ref: 1 }
  })
  on('tool.call', async (_: any, e: any) => {
    seen.id = e.tool_use_id
    seen.input = JSON.stringify(e.questions)
    const box = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions: e.questions } })
    for (let i = 0; i < 200 && waitFor && !seen.drawn.includes(waitFor); i++) await box.drawn()
    return { result: answer(e) }
  })
}

test('问答框：问题和选项显示成中文；选的中文选项换回英文、自己打的中文译成英文再交给 Claude；回答那一行显示中文', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)
  const box = { drawn: '', id: '' }
  dialog(on, $, box, () => ({
    questions: QUESTIONS,
    answers: { '中Which approach?': '中Retry', '中Which checks?': '顺便看看日志' },
    annotations: { '中Which approach?': { notes: '先别动数据库' } },
  }), '中Which approach?')

  await $.prompt.submit({ text: '帮我选个方案', wait: false, origin: { kind: 'composer' } })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })

  // 译文 6 秒内就到：问答框直接以中文弹出
  expect(String((box as any).input).includes('中Which approach?')).toBe(true)
  expect(box.drawn.includes('中Which approach?')).toBe(true)
  expect(box.drawn.includes('中Retry')).toBe(true)
  expect(box.drawn.includes('中Try the call again')).toBe(true)
  expect(box.drawn.includes('中Approach')).toBe(true)
  expect(r.result.answers).toEqual({ 'Which approach?': 'Retry', 'Which checks?': 'EN: 顺便看看日志' })
  expect(r.result.annotations).toEqual({ 'Which approach?': { notes: 'EN: 先别动数据库' } })
  expect(r.result.questions[0].question).toBe('Which approach?')

  const row = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: box.id, tool: 'AskUserQuestion', output: r.result, isErrored: false } })
  const shown = textOf(await row.drawn())
  expect(shown.includes('中Which approach?')).toBe(true)
  expect(shown.includes('中Retry')).toBe(true)
  expect(shown.includes('顺便看看日志')).toBe(true)
  expect(shown.includes('先别动数据库')).toBe(true)
  expect(shown.includes('EN: ')).toBe(false)
})

test('问答框多选：选的几个中文选项都换回英文；自己打的回答（response）译成英文', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)
  const box = { drawn: '', id: '' }
  dialog(on, $, box, () => ({
    questions: QUESTIONS,
    answers: { '中Which checks?': '中Lint, 中Types' },
    response: '其实两个都要',
  }), '中Which checks?')

  await $.prompt.submit({ text: '帮我选个方案', wait: false, origin: { kind: 'composer' } })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
  expect(r.result.answers).toEqual({ 'Which checks?': 'Lint, Types' })
  expect(r.result.response).toBe('EN: 其实两个都要')
})

test('英文对话里的问答框：不翻译，回答原样交给 Claude', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)
  const box = { drawn: '', id: '' }
  dialog(on, $, box, () => ({ questions: QUESTIONS, answers: { 'Which approach?': 'Retry' } }))

  await $.prompt.submit({ text: 'pick an approach', wait: false, origin: { kind: 'composer' } })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
  expect(box.drawn.includes('中')).toBe(false)
  expect(r.result.answers).toEqual({ 'Which approach?': 'Retry' })
  expect(seen.asks.length).toBe(0)
})

test('回答里用的是英文问题和选项（问答框没换成中文时）：照原样，自己打的中文照样译成英文', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)
  const box = { drawn: '', id: '' }
  dialog(on, $, box, () => ({ questions: QUESTIONS, answers: { 'Which approach?': 'Skip', 'Which checks?': '都不用' } }))

  await $.prompt.submit({ text: '帮我选个方案', wait: false, origin: { kind: 'composer' } })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
  expect(r.result.answers).toEqual({ 'Which approach?': 'Skip', 'Which checks?': 'EN: 都不用' })
})

test('问答框没译成（翻译模型给的不是 JSON）：照常显示英文，自己打的中文照样译成英文', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen, { badDialog: true })
  const box = { drawn: '', id: '' }
  dialog(on, $, box, () => ({ questions: QUESTIONS, answers: { 'Which approach?': 'Retry', 'Which checks?': '看情况' } }))

  await $.prompt.submit({ text: '帮我选个方案', wait: false, origin: { kind: 'composer' } })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
  expect(r.result.answers).toEqual({ 'Which approach?': 'Retry', 'Which checks?': 'EN: 看情况' })
  const row = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: box.id, tool: 'AskUserQuestion', output: r.result, isErrored: false } })
  const shown = textOf(await row.drawn())
  expect(shown.includes('Which approach?')).toBe(true)
  expect(shown.includes('看情况')).toBe(true)
})

test('问答框译得慢（10 秒）：等译好再弹出，直接是中文；一题一个请求同时发，每个最多等 20 秒；等的时候提示正在翻译', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  const timeouts: number[] = []
  const clock = fake(on, files, seen, { slowDialog: 10000, dialogTimeouts: timeouts })
  let opened = ''
  on('tool.call', async (_: any, e: any) => {
    opened = JSON.stringify(e.questions)
    return { result: { questions: e.questions, answers: { '中Which approach?': '中Skip' } } }
  })

  await $.prompt.submit({ text: '帮我选个方案', wait: false, origin: { kind: 'composer' } })
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
  await clock.advance(9000)
  expect(opened).toBe('')
  expect(seen.toasts.some(t => t.includes('正在把问答框译成中文'))).toBe(true)
  await clock.advance(2000)
  const r = await call
  expect(opened.includes('中Which approach?')).toBe(true)
  expect(opened.includes('中Which checks?')).toBe(true)
  expect(timeouts).toEqual([20000, 20000])
  expect(r.result.answers).toEqual({ 'Which approach?': 'Skip' })
})

test('问答框里一题没译成：那一题显示英文，其他题照样中文；两种回答都换回英文', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen, { badDialog: 'Which checks?' })
  const box = { drawn: '', id: '', input: '' }
  dialog(on, $, box, () => ({ questions: QUESTIONS, answers: { '中Which approach?': '中Retry', 'Which checks?': 'Lint, Tests' } }))

  await $.prompt.submit({ text: '帮我选个方案', wait: false, origin: { kind: 'composer' } })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
  expect(box.input.includes('中Which approach?')).toBe(true)
  expect(box.input.includes('"question":"Which checks?"')).toBe(true)
  expect(r.result.answers).toEqual({ 'Which approach?': 'Retry', 'Which checks?': 'Lint, Tests' })
})

test('思考块不翻：引擎直接画屏幕上的思考摘要，插件换不上去，翻了白花钱', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  await $.prompt.submit({ text: '帮我看看', wait: false, origin: { kind: 'composer' } })
  const asked = seen.asks.length
  await append($, { type: 'assistant', role: 'assistant', content: [{ type: 'thinking', thinking: 'Checking the log first.', signature: 'sig' }] }, 'th1')
  expect(seen.asks.length).toBe(asked)
})

test('问答框多选又自己打了字：选的选项一字不差地换回英文，只把自己打的字译成英文', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)
  const box = { drawn: '', id: '' }
  dialog(on, $, box, () => ({ questions: QUESTIONS, answers: { '中Which checks?': '中Lint, 中Types, 顺便跑一下性能测试' } }), '中Which checks?')

  await $.prompt.submit({ text: '帮我选个方案', wait: false, origin: { kind: 'composer' } })
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
  expect(r.result.answers).toEqual({ 'Which checks?': 'Lint, Types, EN: 顺便跑一下性能测试' })

  const row = await $.ui.mount({ plugin: 'zh-translate', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: box.id, tool: 'AskUserQuestion', output: r.result, isErrored: false } })
  expect(textOf(await row.drawn()).includes('中Lint, 中Types, 顺便跑一下性能测试')).toBe(true)
})

// ---------- 第八轮：只发截图（没有文字）的消息 ----------

test('只发截图（没有文字）：沿用上一条的语言；上一条是中文，回复照样翻，也照样请 Claude 用英文回复', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  await $.prompt.submit({ text: '帮我看看这个', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: '[Image #4]', wait: false, origin: { kind: 'composer' } })
  expect(seen.submitted?.text).toBe('[Image #4]')
  expect((seen.submitted?.context ?? []).some(c => c.includes('Write your reply in English'))).toBe(true)
  await reply($, 'The dialog opened in English.', 'img1')
  const m = await mountReply($, 'The dialog opened in English.')
  expect((await drawnUntil(m, '中文：The dialog opened in English.')).includes('中文：The dialog opened in English.')).toBe(true)
})

test('只发截图：上一条是英文就照旧不翻；新会话第一条只发截图按中文算', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  // 新会话：第一条只发截图（带粘贴内容的占位也一样）
  await $.prompt.submit({ text: '[Image #1] [Pasted text #1 +20 lines]', wait: false, origin: { kind: 'composer' } })
  await reply($, 'First look.', 'img2')
  const first = await mountReply($, 'First look.')
  expect((await drawnUntil(first, '中文：First look.')).includes('中文：First look.')).toBe(true)

  // 用英文问了一句，再只发截图：照旧英文，不翻
  await $.prompt.submit({ text: 'what does this error mean?', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: '[Image #2]', wait: false, origin: { kind: 'composer' } })
  const asked = seen.asks.length
  await reply($, 'It means the port is busy.', 'img3')
  expect(seen.asks.length).toBe(asked)
  expect((seen.submitted?.context ?? []).some(c => c.includes('Write your reply in English'))).toBe(false)
})

test('只回一两个英文词（OK、yes）：沿用上一条的语言；上一条是中文，回复照样翻；上一条是英文就不翻', async ($: any, on: any) => {
  const files: Record<string, string> = {}
  const seen: Seen = { asks: [], closed: [], toasts: [] }
  fake(on, files, seen)

  await $.prompt.submit({ text: '可以发布了吗', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'OK', wait: false, origin: { kind: 'composer' } })
  expect(seen.submitted?.text).toBe('OK')
  expect((seen.submitted?.context ?? []).some(c => c.includes('Write your reply in English'))).toBe(true)
  await reply($, 'Publishing now.', 'ok1')
  const m = await mountReply($, 'Publishing now.')
  expect((await drawnUntil(m, '中文：Publishing now.')).includes('中文：Publishing now.')).toBe(true)

  await $.prompt.submit({ text: 'what does this error mean?', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'go ahead', wait: false, origin: { kind: 'composer' } })
  const asked = seen.asks.length
  await reply($, 'Done.', 'ok2')
  expect(seen.asks.length).toBe(asked)
})
