// 客户端渲染自检：用最小 DOM 桩跑真实 app.js，喂真实分析结果，检查三块内容是否都渲染出来。
// 用法：node test/client.test.mjs [结果json路径]
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const fixturePath = process.argv[2] || '/tmp/out2.json';
const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const data = raw.data || raw;

const mkEl = (id = '') => {
  const classes = new Set();
  const el = {
    id, innerHTML: '', textContent: '', value: '', checked: false, href: '', dataset: {}, style: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, f) => (f === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (f ? classes.add(c) : classes.delete(c))),
      contains: (c) => classes.has(c),
    },
    addEventListener() {}, focus() {}, querySelectorAll: () => [], appendChild() {}, remove() {},
  cloneNode() { return this; },
  };
  return el;
};
const els = new Map();
const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };

// 预置几个带初始值的元素
getEl('langSelect').value = 'zh';
getEl('historyModal').classList.add('hidden');   // 对应 index.html 的 class="hidden"
getEl('result').classList.add('hidden');
getEl('status').classList.add('hidden');
getEl('error').classList.add('hidden');
const tabEls = ['one', 'story', 'setup'].map(t => { const e = mkEl('tab-' + t); e.dataset.tab = t; return e; });
const panelEls = ['one', 'story', 'setup'].map(t => { const e = mkEl('panel-' + t); e.dataset.tab = t; return e; });

const bodyEl = mkEl('body'); bodyEl.style = {};
const document = {
  body: bodyEl,
  getElementById: getEl,
  querySelectorAll: (sel) => (sel === '.tab' ? tabEls : sel === '.panel' ? panelEls : []),
  querySelector: () => null,
};

const errors = [];
const sandbox = {
  console, setTimeout, clearTimeout, setInterval: (fn) => { return 0; }, clearInterval() {},
  fetch: async (url) => {
    const u = String(url);
    if (u.includes('/api/analyze')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
    }
    if (u.endsWith('/api/history')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [
        { id: 'a__b__1', full_name: 'a/b', stars: 12, products: 2, analyzedAt: '2026-11-12T03:00:00Z', description: 'demo' },
        { id: 'c__d__2', full_name: 'c/d', stars: 3, products: 1, analyzedAt: '2026-11-11T03:00:00Z', description: '' },
      ] }) };
    }
    if (u.includes('/api/history/item')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
    }
    throw new Error('unexpected fetch ' + url);
  },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { clipboard: { readText: async () => '', writeText: async () => {} } },
  location: { hash: '#url=https%3A%2F%2Fgithub.com%2Fjiamiaomiao029-gif%2Fliushui-skills' },
  history: { replaceState() {} },
  window: { scrollTo() {} },
  document,
  AbortSignal,
  encodeURIComponent, decodeURIComponent, JSON, Math, Date, Number, String, Array, Object, RegExp, Error, Promise,
};
sandbox.globalThis = sandbox;
sandbox.window.document = document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.navigator = sandbox.navigator;
sandbox.window.location = sandbox.location;
sandbox.window.history = sandbox.history;

process.on('uncaughtException', (e) => { errors.push(e); });

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'discover', 'app.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'app.js' });

// 等异步 run() 把结果写进 DOM
const started = Date.now();
while (Date.now() - started < 8000) {
  if (getEl('productGrid').innerHTML.length > 0 || getEl('error').classList.contains('hidden') === false && getEl('result').classList.contains('hidden')) break;
  await new Promise(r => setTimeout(r, 100));
}

const checks = [];
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

ok('没有抛异常', errors.length === 0, errors.map(e => e.message).join('; '));
ok('结果区已显示', !getEl('result').classList.contains('hidden'));
ok('仓库名渲染', getEl('repoName').textContent.length > 2, getEl('repoName').textContent);
ok('产品卡片 = ' + (data.products?.length || 0) + ' 张', (getEl('productGrid').innerHTML.match(/class="card"/g) || []).length === (data.products?.length || 0));
ok('一句话非空', getEl('oneLiner').innerHTML.trim().length > 10);
ok('难题列表非空', getEl('problems').innerHTML.includes('item-h'));
ok('谁需要非空', getEl('whoNeeds').innerHTML.includes('item-h'));
ok('口语讲解非空', getEl('storyText').innerHTML.trim().length > 50);
ok('作者来路 5 阶段', (getEl('storyStages').innerHTML.match(/class="stage"/g) || []).length === 5);
ok('原文引用块存在', data.authorStory && Object.values(data.authorStory).some(v => Array.isArray(v) && v.some(i => i.quote)) ? getEl('storyStages').innerHTML.includes('class="orig"') : true);
ok('AI 推断有「」高亮', getEl('storyStages').innerHTML.includes('class="guess"') || getEl('aiThread').innerHTML.includes('class="guess"'));
ok('前置工具渲染', getEl('prereq').innerHTML.includes('pre-name'));
ok('步骤渲染', (getEl('steps').innerHTML.match(/<li>/g) || []).length >= 2);
ok('风险渲染', getEl('risks').innerHTML.includes('risk-h'));
ok('结论渲染', getEl('verdict').innerHTML.includes('verdict-label'));
ok('无错误提示', getEl('error').classList.contains('hidden'));
ok('历史弹窗默认隐藏', getEl('historyModal').classList.contains('hidden'));
ok('历史列表已渲染', getEl('historyList').innerHTML.includes('hist-item'));
ok('历史条数正确', (getEl('historyList').innerHTML.match(/class="hist-item"/g) || []).length === 2);
ok('下载按钮存在', typeof getEl('pdfBtn').onclick === 'function');
ok('历史标题显示条数', getEl('historyCount').textContent.includes('2'));
getEl('historyBtn').onclick();
ok('点历史按钮弹窗出现', !getEl('historyModal').classList.contains('hidden'));
getEl('historyClose').onclick();
ok('关闭按钮收起弹窗', getEl('historyModal').classList.contains('hidden'));

let fail = 0;
for (const c of checks) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? '  → ' + c.detail : ''}`);
  if (!c.pass) fail++;
}
console.log(`\n${checks.length - fail}/${checks.length} 通过`);
process.exit(fail ? 1 : 0);
