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
let total = 0;
try {
  // 插件把本会话累计写在它的状态文件里
  total = JSON.parse(fs.readFileSync(path.join(dir, `plugin-state-${sid}.json`), 'utf8')).spent || 0;
} catch {
  try { total = fs.readFileSync(path.join(dir, `cost-${sid}.log`), 'utf8').split('\n').reduce((s, l) => s + (parseFloat(l) || 0), 0); } catch {}
}

const model = config.model || 'sonnet';
process.stdout.write(`译: ${prettyName(model)} $${total.toFixed(3)}`);
