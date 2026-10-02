#!/usr/bin/env node
// Claude Code 中文翻译 安装脚本。用法：node install.mjs [--force]
// 插件装到 ~/.claude/skills/zh-translate（Claude Code 启动时自动加载），设置和词表在 ~/.claude/zh-translate。
// 装过旧版（command hook 版）会顺手清掉旧的 hook 和命令，设置和词表保留。重复运行是安全的。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 插件接口是新功能，2.1.287 是测试过的版本；更老的版本加载不了这种插件
const MIN_VERSION = '2.1.287';

const force = process.argv.includes('--force');
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLUGIN = path.join(CLAUDE_DIR, 'skills', 'zh-translate');
const DATA = path.join(CLAUDE_DIR, 'zh-translate');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const slash = p => p.replace(/\\/g, '/');
const ok = msg => console.log(`✓ ${msg}`);
const warn = msg => console.log(`! ${msg}`);
const fail = msg => { console.error(`\n✗ ${msg}`); process.exit(1); };
const isOldHook = h => [h.command, ...(h.args || [])].some(s => slash(String(s || '')).includes('/zh-translate/hook.mjs'));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

console.log('安装 Claude Code 中文翻译\n');

if (+process.versions.node.split('.')[0] < 18) fail(`需要 Node.js 18 或更新，当前是 ${process.versions.node}`);

// 找到启动 claude 的方式。Windows 上 npm 装的是 claude.cmd 外壳，改用 node 跑它的 cli.js
function findClaude() {
  const win = process.platform === 'win32';
  let hits = [];
  try {
    hits = execFileSync(win ? 'where' : 'which', win ? ['claude'] : ['-a', 'claude'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } catch {}
  for (const h of hits) {
    if (!win || /\.exe$/i.test(h)) return [h];
    if (/\.cmd$/i.test(h)) {
      const cli = path.join(path.dirname(h), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (fs.existsSync(cli)) return [process.execPath, cli];
    }
  }
  return null;
}

const claude = findClaude();
if (!claude) fail('找不到 claude 命令。请先安装 Claude Code，并确认在终端里能运行 claude。');
let version = '';
try {
  version = (execFileSync(claude[0], [...claude.slice(1), '--version'], { encoding: 'utf8', timeout: 60000 }).match(/\d+\.\d+\.\d+/) || [''])[0];
} catch {}
const older = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};
if (!version && !force) fail('读不到 Claude Code 的版本号。确定要装的话加 --force 重新运行。');
if (version && older(version, MIN_VERSION) && !force) {
  fail(`Claude Code 版本是 ${version}，需要 ${MIN_VERSION} 或更新。先运行 claude update 升级（确定要装可以加 --force）。`);
}
ok(`Claude Code ${version || '（版本未知）'}`);

// 不覆盖别人的同名插件
const pluginJson = path.join(PLUGIN, '.claude-plugin', 'plugin.json');
if (fs.existsSync(PLUGIN) && !force) {
  let name = '';
  try { name = readJson(pluginJson).name; } catch {}
  if (name !== 'zh-translate' || !fs.existsSync(path.join(PLUGIN, 'hooks', 'register.tsx'))) {
    fail(`${PLUGIN} 已经存在，而且不是本工具。先把它改名或删掉，或者加 --force 覆盖。`);
  }
}
// 别人的 /zh、/zh-model 命令会和插件的命令重名
for (const name of ['zh', 'zh-model']) {
  const f = path.join(CLAUDE_DIR, 'skills', name, 'SKILL.md');
  if (fs.existsSync(f) && !fs.readFileSync(f, 'utf8').includes('zh-translate') && !force) {
    fail(`已经有一个不是本工具的 /${name} 命令（${f}），会和插件的命令重名。先把它改名或删掉，或者加 --force。`);
  }
}

// settings.json 先读出来校验：装过旧版的话要从里面去掉旧 hook
let settings = null;
if (fs.existsSync(SETTINGS)) {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  try { settings = raw.trim() ? JSON.parse(raw) : {}; } catch { fail(`${SETTINGS} 不是合法的 JSON，没有做任何改动。请先修好它再安装。`); }
}

// 插件：整个目录换成新的
fs.rmSync(PLUGIN, { recursive: true, force: true });
fs.cpSync(path.join(SRC, 'plugin'), PLUGIN, { recursive: true });
ok(`插件已装到 ${PLUGIN}`);

// 设置和词表：保留原来的模式、范围、模型和词表
fs.mkdirSync(DATA, { recursive: true });
fs.copyFileSync(path.join(SRC, 'zh-translate', 'status.mjs'), path.join(DATA, 'status.mjs'));
if (!fs.existsSync(path.join(DATA, 'glossary.txt'))) fs.copyFileSync(path.join(SRC, 'zh-translate', 'glossary.txt'), path.join(DATA, 'glossary.txt'));
let config = { enabled: true, mode: 'only', scope: 'all', model: 'sonnet', showCost: true };
try { config = { ...config, ...readJson(path.join(DATA, 'config.json')) }; } catch {}
delete config.claudeCmd; // 旧版用的，插件不需要
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(config, null, 2));
ok(`设置和词表在 ${DATA}`);

// 清掉旧版：command hook、旧命令、旧脚本
let removed = 0;
if (settings?.hooks) {
  for (const event of Object.keys(settings.hooks)) {
    const groups = (settings.hooks[event] || []).map(g => {
      const kept = (g.hooks || []).filter(h => !isOldHook(h));
      removed += (g.hooks || []).length - kept.length;
      return { ...g, hooks: kept };
    }).filter(g => g.hooks.length);
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}
if (removed) {
  const bak = `${SETTINGS}.bak-zh-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SETTINGS, bak);
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  ok(`已从 settings.json 去掉旧版的 ${removed} 个 hook（备份：${path.basename(bak)}）`);
}
for (const name of ['zh', 'zh-model']) {
  const dir = path.join(CLAUDE_DIR, 'skills', name);
  const f = path.join(dir, 'SKILL.md');
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('zh-translate')) {
    fs.rmSync(dir, { recursive: true, force: true });
    ok(`已删除旧版的 /${name} 命令（插件自带新的）`);
  }
}
for (const old of ['hook.mjs', 'hook.prev.mjs']) {
  if (fs.existsSync(path.join(DATA, old))) { fs.rmSync(path.join(DATA, old)); ok(`已删除旧版的 ${old}`); }
}
if (settings?.disableAllHooks) warn('你的 settings.json 里设了 disableAllHooks: true，插件的钩子也不会运行，需要把它去掉。');

console.log(`
安装完成。重新打开 claude 后生效：直接用中文提问即可。
  /zh          查看状态；/zh on | off | only | both | all | final 开关和切换
  /zh-model    上下键选择翻译用的模型
  词表         ${slash(path.join(DATA, 'glossary.txt'))}

可选：在状态栏显示翻译模型和费用。用 ccstatusline 的话，加一个“自定义命令”组件，命令填：
  "${slash(process.execPath)}" "${slash(path.join(DATA, 'status.mjs'))}"`);
