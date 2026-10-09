// ccstatusline 自定义命令：显示中文翻译的开关、模型和本会话翻译费用，如“译: Sonnet 5.5 $0.012”
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ALIASES = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
// claude-sonnet-5-5 → Sonnet 5.5（和插件的起名规则一致）
const prettyName = m => {
  const p = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(ALIASES[m] || m);
  return p ? `${p[1][0].toUpperCase()}${p[1].slice(1)} ${p[2]}${p[3] ? '.' + p[3] : ''}` : m;
};

let config = { enabled: true };
try { config = { ...config, ...JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')) }; } catch {}
if (!config.enabled) { process.stdout.write('译: 关'); process.exit(0); }

let sessionId = '';
try { sessionId = JSON.parse(fs.readFileSync(0, 'utf8')).session_id || ''; } catch {}
const sid = String(sessionId).replace(/[^\w-]/g, '_');
const dir = path.join(os.tmpdir(), 'claude-zh');
let state = {};
let total = 0;
try {
  // 插件把本会话累计和在用的模型写在它的状态文件里
  state = JSON.parse(fs.readFileSync(path.join(dir, `plugin-state-${sid}.json`), 'utf8'));
  total = state.spent || 0;
} catch {
  try { total = fs.readFileSync(path.join(dir, `cost-${sid}.log`), 'utf8').split('\n').reduce((s, l) => s + (parseFloat(l) || 0), 0); } catch {}
}

// 显示这个窗口的插件真正在用的模型。没有 using 说明这个窗口跑的是旧版插件，
// 它不认识外部 API 的设置，用的就是 Claude 的模型——别跟着设置谎报成外部模型
const name = state.using || prettyName(config.model || 'sonnet');
// 设置里关了“显示翻译费用”就只显示模型
process.stdout.write(config.showCost === false ? `译: ${name}` : `译: ${name} $${total.toFixed(3)}`);
