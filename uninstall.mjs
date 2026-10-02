#!/usr/bin/env node
// Claude Code 中文翻译 卸载脚本。用法：node uninstall.mjs
// 删除插件 ~/.claude/skills/zh-translate、设置和词表 ~/.claude/zh-translate、临时文件；旧版留下的 hook 和命令也一并去掉。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLUGIN = path.join(CLAUDE_DIR, 'skills', 'zh-translate');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const slash = p => p.replace(/\\/g, '/');
const ok = msg => console.log(`✓ ${msg}`);
const isOldHook = h => [h.command, ...(h.args || [])].some(s => slash(String(s || '')).includes('/zh-translate/hook.mjs'));

console.log('卸载 Claude Code 中文翻译\n');

// 只删本工具的插件
let name = '';
try { name = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).name; } catch {}
if (name === 'zh-translate') { fs.rmSync(PLUGIN, { recursive: true, force: true }); ok('已删除插件'); }
else if (fs.existsSync(PLUGIN)) console.log(`! ${PLUGIN} 不是本工具的插件，没有删`);

// 旧版留下的 command hook
if (fs.existsSync(SETTINGS)) {
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {
    console.error(`✗ ${SETTINGS} 不是合法的 JSON，没有改动它。如果装过旧版，请手动删掉里面指向 zh-translate/hook.mjs 的 hook。`);
  }
  let removed = 0;
  for (const event of Object.keys(settings?.hooks || {})) {
    const groups = (settings.hooks[event] || []).map(g => {
      const kept = (g.hooks || []).filter(h => !isOldHook(h));
      removed += (g.hooks || []).length - kept.length;
      return { ...g, hooks: kept };
    }).filter(g => g.hooks.length);
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  if (removed) {
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    const bak = `${SETTINGS}.bak-zh-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(SETTINGS, bak);
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    ok(`已从 settings.json 去掉旧版的 hook（备份：${path.basename(bak)}）`);
  }
}

// 旧版的 /zh、/zh-model 命令（只删本工具的）
for (const n of ['zh', 'zh-model']) {
  const dir = path.join(CLAUDE_DIR, 'skills', n);
  const f = path.join(dir, 'SKILL.md');
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('zh-translate')) { fs.rmSync(dir, { recursive: true, force: true }); ok(`已删除旧版的 /${n} 命令`); }
}

fs.rmSync(path.join(CLAUDE_DIR, 'zh-translate'), { recursive: true, force: true });
fs.rmSync(path.join(os.tmpdir(), 'claude-zh'), { recursive: true, force: true });
ok('已删除设置、词表和临时文件');
console.log('\n卸载完成。重新打开 claude 后生效。如果状态栏里加过翻译组件，记得把它也删掉。');
