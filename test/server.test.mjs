// 服务端自检：自己拉起一个临时端口的实例，检查静态页、健康检查、错误分支、路径穿越。
// 不消耗模型额度（不触发真正的分析）。
import { spawn } from 'node:child_process';
import path from 'node:path';

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(import.meta.dirname, '..');

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', d => (log += d));
child.stderr.on('data', d => (log += d));

const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('服务没起来：\n' + log);
};

const checks = [];
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

const post = async (body) => {
  const r = await fetch(BASE + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

try {
  await waitFor(async () => (await fetch(BASE + '/api/health')).ok);

  const h = await (await fetch(BASE + '/api/health')).json();
  ok('健康检查', h.ok === true && h.key === true, `model=${h.model} key=${h.key}`);

  const idx = await fetch(BASE + '/');
  ok('首页 200', idx.status === 200 && (await idx.text()).includes('Repo Radar'));

  for (const f of ['/app.js', '/style.css']) {
    const r = await fetch(BASE + f);
    ok(`静态文件 ${f}`, r.status === 200);
  }

  const t1 = await post({});
  ok('空链接被拒', t1.status === 400 && /请先粘贴/.test(t1.json.error), t1.json.error);

  const t2 = await post({ url: 'https://gitlab.com/a/b' });
  ok('非 github 被拒', t2.status === 400 && /只支持 github/.test(t2.json.error), t2.json.error);

  const t3 = await post({ url: 'https://github.com/jiamiaomiao029-gif/definitely-not-exist-xyz' });
  ok('不存在的仓库报 404', t3.status === 400 && /404/.test(t3.json.error), t3.json.error);

  const trav = await fetch(BASE + '/../server.mjs');
  ok('路径穿越被挡', trav.status === 403 || trav.status === 404, 'status=' + trav.status);

  const nf = await fetch(BASE + '/nope.txt');
  ok('未知路径 404', nf.status === 404);

  const hist = await (await fetch(BASE + '/api/history')).json();
  ok('历史接口返回列表', hist.ok === true && Array.isArray(hist.items));

  const bad = await (await fetch(BASE + '/api/history/item?id=../../etc/passwd')).json();
  ok('历史 id 防穿越', bad.ok === false, bad.error);

  if (hist.items.length) {
    const one = await (await fetch(BASE + '/api/history/item?id=' + encodeURIComponent(hist.items[0].id))).json();
    ok('历史条目可读取', one.ok === true && !!one.data.repo, one.data?.repo?.full_name);
  }

  const pdf = await fetch(BASE + '/vendor/jspdf.umd.min.js');
  ok('PDF 依赖已就位', pdf.status === 200);
} catch (e) {
  ok('测试执行', false, e.message);
} finally {
  child.kill();
}

let fail = 0;
for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? '  → ' + c.detail : ''}`);
  if (!c.pass) fail++;
}
console.log(`\n${checks.length - fail}/${checks.length} 通过`);
process.exit(fail ? 1 : 0);
