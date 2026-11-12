#!/usr/bin/env node
// Repo Radar —— 粘贴 GitHub 链接，看清一个工具：它是什么、作者怎么想到的、我该怎么装上用起来。
// 零依赖：只用 Node 内置模块（node >= 18）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4321);
const CACHE_DIR = path.join(__dirname, '.cache');
const LLM_BASE = process.env.LLM_BASE || 'https://api.deepseek.com';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-flash';

fs.mkdirSync(CACHE_DIR, { recursive: true });
const HISTORY_DIR = path.join(CACHE_DIR, 'history');
const HISTORY_INDEX = path.join(HISTORY_DIR, 'index.json');
fs.mkdirSync(HISTORY_DIR, { recursive: true });

function loadEnv() {
  const f = path.join(__dirname, '.env.local');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\\n$/, '').trim();
    }
  }
}
loadEnv();

// ---------- GitHub ----------
const GH = 'https://api.github.com';
function ghHeaders() {
  const h = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'repo-radar' };
  if (process.env.GITHUB_TOKEN) h['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}
async function ghJson(url) {
  const r = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(25000) });
  if (r.status === 404) throw new Error('仓库不存在或未公开（404）');
  if (r.status === 403) throw new Error('GitHub API 频率限制（未登录每小时 60 次），请过一会儿再试或配置 GITHUB_TOKEN');
  if (!r.ok) throw new Error(`GitHub API 返回 ${r.status}`);
  return r.json();
}

function parseRepoUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('请先粘贴 GitHub 链接');
  let u;
  try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); } catch { throw new Error('链接格式不对，例如 https://github.com/作者/仓库 或 https://github.com/作者'); }
  if (!/(^|\.)github\.com$/.test(u.hostname)) throw new Error('目前只支持 github.com 的仓库链接');
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length < 1) throw new Error('链接里没有作者名，例如 https://github.com/作者');
  const owner = seg[0];
  if (seg.length < 2) return { owner, repo: null, sub: '', kind: 'owner' };
  const repo = seg[1].replace(/\.git$/, '');
  if (['repositories', 'stars', 'followers', 'following'].includes(repo)) return { owner, repo: null, sub: '', kind: 'owner' };
  let sub = '';
  const idx = seg.findIndex((s, i) => i >= 2 && (s === 'tree' || s === 'blob'));
  if (idx > 0 && seg[idx + 2]) sub = seg.slice(idx + 2).join('/');
  return { owner, repo, sub, kind: 'repo' };
}

const DOC_PRIORITY = /(readme|skill\.md|package\.json|plugin\.json|marketplace\.json|\.claude-plugin|agents\/|pyproject|requirements|install|setup|usage|docs?\/|notes?|design|why|story|背景|设计|思路|架构|决策|说明|介绍)/i;

async function ghRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
}

// 一次 tarball 拿到整仓：不消耗 GitHub API 配额，也不会被 raw 域名限流
async function fetchTarball(owner, repo, branch) {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(branch)}`;
  const buf = await ghRetry(async () => {
    const r = await fetch(url, { headers: { 'User-Agent': 'repo-radar' }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`下载仓库压缩包失败（${r.status}）`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 80 * 1024 * 1024) throw new Error('仓库体积过大（>80MB），暂不支持');
    return Buffer.from(await r.arrayBuffer());
  });
  return zlib.gunzipSync(buf);
}

// 极简 tar 解析：只取普通文件的 path → utf8 文本
function readTar(gz, maxFiles = 4000) {
  const files = new Map();
  let off = 0, n = 0;
  while (off + 512 <= gz.length && n < maxFiles) {
    const header = gz.subarray(off, off + 512);
    if (header.every(b => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const dataStart = off + 512;
    const body = gz.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    n++;
    if (type !== '0' && type !== '\0') continue;
    // 去掉顶层目录，如 repo-main/
    const p = full.split('/').slice(1).join('/');
    if (!p || /(^|\/)(node_modules|\.git)\//.test(p)) continue;
    if (size > 300 * 1024) continue;
    if (!/\.(md|mdx|txt|json|toml|ya?ml|py|sh)$/i.test(p) && !/^LICENSE/i.test(p) && p !== 'Makefile') continue;
    files.set(p, body.toString('utf8'));
  }
  return files;
}

async function collectRepo(owner, repo) {
  const meta = await ghRetry(() => ghJson(`${GH}/repos/${owner}/${repo}`));
  const branch = meta.default_branch || 'main';

  let files = new Map();
  try {
    files = readTar(await fetchTarball(owner, repo, branch));
  } catch (e) {
    console.warn('[tarball]', e.message, '→ 回退到 README API');
    try {
      const rd = await ghJson(`${GH}/repos/${owner}/${repo}/readme`);
      files.set(rd.name || 'README.md', Buffer.from(rd.content || '', 'base64').toString('utf8'));
    } catch {}
  }

  const paths = [...files.keys()];
  const mdPaths = paths.filter(p => /\.(md|mdx)$/i.test(p));
  const score = (p) => {
    let s = 0;
    if (DOC_PRIORITY.test(p)) s += 10;
    if (/skill\.md$/i.test(p)) s += 6;
    if (/^(docs?|references?)\//i.test(p)) s += 3;
    if (/source-notes|changelog|license/i.test(p)) s += 4;
    if (/^(readme)\.mdx?$/i.test(p)) s += 20;
    return s - p.split('/').length;
  };

  const chosen = [];
  const readme = mdPaths.find(p => /^readme\.mdx?$/i.test(p)) || mdPaths.find(p => /\/readme\.mdx?$/i.test(p));
  if (readme) chosen.push(readme);
  for (const p of ['package.json', '.claude-plugin/marketplace.json', 'pyproject.toml']) {
    if (files.has(p)) chosen.push(p);
  }
  for (const p of mdPaths.filter(p => p !== readme).sort((a, b) => score(b) - score(a)).slice(0, 10)) chosen.push(p);

  const docs = [];
  let budget = 36000;
  for (const p of [...new Set(chosen)]) {
    const text = files.get(p) || '';
    if (!text.trim() || budget <= 0) continue;
    const cap = p === readme ? 24000 : 6000;
    const chunk = text.slice(0, Math.min(cap, budget));
    docs.push({ path: p, text: chunk });
    budget -= chunk.length;
  }

  return {
    repo: {
      full_name: meta.full_name,
      html_url: meta.html_url,
      description: meta.description || '',
      stars: meta.stargazers_count,
      forks: meta.forks_count,
      language: meta.language,
      license: meta.license?.spdx_id || null,
      pushed_at: meta.pushed_at,
      created_at: meta.created_at,
      topics: meta.topics || [],
      archived: meta.archived,
      branch,
    },
    tree: paths, docs,
  };
}

// ---------- 作者主页模式 ----------
function parseRepoName(full) { const [o, r] = String(full).split('/'); return { owner: o, repo: r }; }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  }));
  return out;
}

async function collectOwner(owner) {
  const user = await ghRetry(() => ghJson(`${GH}/users/${encodeURIComponent(owner)}`));
  const repos = await ghRetry(() => ghJson(`${GH}/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`));
  if (!Array.isArray(repos) || !repos.length) throw new Error('这个作者没有公开仓库');

  const list = repos
    .filter(r => !r.archived)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 40)
    .map(r => ({
      name: r.name, full_name: r.full_name, url: r.html_url, desc: r.description || '',
      stars: r.stargazers_count, lang: r.language, fork: r.fork, pushed: r.pushed_at,
      default_branch: r.default_branch,
      topics: r.topics || [], readme: '',
    }));

  // 每个仓库只读 README 开头（够判断它是干什么的）
  await mapLimit(list, 6, async (r) => {
    for (const br of [r.default_branch, 'main', 'master'].filter(Boolean)) {
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${r.full_name}/${br}/README.md`, { signal: AbortSignal.timeout(12000) });
        if (res.ok) { r.readme = (await res.text()).slice(0, 1400); return; }
      } catch {}
    }
  });

  return { user, repos: list };
}

function buildOwnerContext({ user, repos }) {
  const head = [
    `# 作者：${user.login}${user.name ? `（${user.name}）` : ''}`,
    `主页：${user.html_url}`,
    `简介：${user.bio || '（未填写）'}`,
    `公开仓库：${user.public_repos} 个｜关注者：${user.followers}｜总星标：${repos.reduce((s, r) => s + r.stars, 0)}`,
    `本次分析仓库数：${repos.length}（按星标排序，已排除归档）`,
  ].join('\n');

  const table = repos.map((r, i) =>
    `${i + 1}. ${r.full_name}  ★${r.stars}  ${r.lang || '—'}  ${r.fork ? '[fork]' : ''}  ${r.desc || '（无简介）'}`).join('\n');

  let body = '';
  let budget = 30000;
  for (const r of repos) {
    if (budget <= 0) break;
    const chunk = (r.readme || '').slice(0, Math.min(1300, budget));
    body += `\n\n===== 仓库：${r.full_name} =====\n${chunk || '（没有 README 文本）'}`;
    budget -= chunk.length;
  }
  return { head: `${head}\n\n## 仓库清单\n${table}`, body };
}


function buildContext({ repo, tree, docs }) {
  const head = [
    `# 仓库：${repo.full_name}`,
    `主页：${repo.html_url}`,
    `作者描述：${repo.description || '（无）'}`,
    `Star：${repo.stars}｜Fork：${repo.forks}｜主语言：${repo.language || '未知'}｜License：${repo.license || '未声明'}`,
    `创建：${repo.created_at}｜最近提交：${repo.pushed_at}｜默认分支：${repo.branch}${repo.archived ? '｜⚠️ 已归档' : ''}`,
    `Topics：${repo.topics.join(', ') || '（无）'}`,
    '',
    `## 文件树（共 ${tree.length} 个文件，节选）`,
    tree.slice(0, 220).join('\n'),
  ].join('\n');

  let body = '';
  let budget = 34000;
  for (const d of docs) {
    if (budget <= 0) break;
    const chunk = d.text.slice(0, Math.min(budget, d.text.length));
    body += `\n\n===== 文件：${d.path} =====\n${chunk}`;
    budget -= chunk.length;
  }
  return { head, body };
}

// ---------- 提示词 ----------
const MACHINE = `【使用者机器（必须据此判断能不能跑）】
- MacBook Pro (Retina, 15-inch, Mid 2015)，Intel 四核 i7 2.2GHz，16GB 内存，Intel Iris Pro 1536MB 核显
- macOS Monterey 12.7.6（无法升级到 13+；Docker Desktop 新版、Xcode 15+、部分 Apple Silicon 专用二进制不可用）
- 已装：Node.js v24、Python 3.10、Homebrew 可用、zsh
- 无 NVIDIA/AMD 独显 → 没有 CUDA；本地大模型只能 CPU 跑小模型（≤7B 量化），语音转写/文生图之类的 GPU 加速会非常慢`;

function buildPrompt(ctx, lang) {
  return `你是一名"读得懂人话"的仓库讲解员。读者是产品/运营背景、会装软件但不想读源码的人，他要弄明白：这个工具干什么、作者为什么做、自己要怎么用上。
请只依据我给你的仓库材料（README、SKILL.md、docs、package.json 等）作答。

【铁律】
1) 凡是作者自己写过的话，只能用材料里的原话（原文照抄，中英文都保留原样），放进 quote 字段；quote 必须能在材料里逐字找到，不要改写、不要拼接。source 填文件路径。
2) 凡是作者没写、由你推断的内容，只能放在 authorStory 的 text 里并标 "inferred": true；aiThread 整段天然是推断。除此之外（oneLiner、story、products、setup 等）全部是有材料依据的陈述或转述，不要标推断。
   除 quote 字段外，所有文本里都不允许出现「」这两个符号（程序会自动给推断加）。要强调时用反引号或直接写。
3) 材料没写的东西就写"作者未说明"，绝不许编造功能、数据、用户量、效果、公司、价格。
4) 语言：${lang === 'en' ? '英文为主，专有名词保留原文' : '中文（简体），专有名词/命令/文件名保留英文原文'}。
5) oneLiner 要像一个人当面给另一个人讲：具体、有画面、说人先遇到什么麻烦，不说空话套话（不要"赋能""一站式""助力"）。
6) 安装步骤只写"装什么工具 + 做什么动作"，不要贴大段代码；命令最多在 install 字段里给一行。
7) 产品清单要覆盖仓库里展示的"全部"可交付物（多个 skill / 插件 / 子工具 / 模块都要列），每个产品一卡片；单工具仓库就只列 1 个。

${MACHINE}

【输出 json（只输出 JSON 对象，不要 markdown 代码块）】
{
  "repoNote": "一句话点出这个仓库现在处于什么阶段（原型/可用/成熟），依据 star 数、README 自述、是否归档等",
  "products": [
    {"name": "仓库里的名字", "what": "它做什么（2 句以内，人话）", "for": "什么场景/什么人会用", "evidence": "支撑它的文件路径"}
  ],
  "oneLiner": {
    "oneLiner": "一句话：这个工具是做什么的",
    "problems": [{"pain": "它解决的具体难题", "scene": "现实中这个难题长什么样（1-2 句具体场面）"}],
    "whoNeeds": [{"who": "一类具体的人", "trigger": "他会在什么时刻想起要用它"}],
    "story": "180-260 字的口语化讲解，像朋友在咖啡桌边说给另一个人听：先说你会碰到什么麻烦，再说它怎么帮你，最后说一句它的边界。不要分点。"
  },
  "authorStory": {
    "discovered": [{"text": "他发现了什么（陈述句，不加引号）", "quote": "作者原话；没有就空字符串", "source": "文件路径；没有就空字符串", "inferred": false}],
    "need": [{"text": "这对应他自己的什么需求", "quote": "", "source": "", "inferred": false}],
    "thinking": [{"text": "他怎么做设计取舍（按他的思考顺序）", "quote": "", "source": "", "inferred": false}],
    "practice": [{"text": "他实际怎么跑、跑了什么", "quote": "", "source": "", "inferred": false}],
    "results": [{"text": "结果/数据/尚未验证的部分", "quote": "", "source": "", "inferred": false}],
    "aiThread": "80-140 字的推断：把作者没明说、但材料透出的思路脉络串起来（他为什么会这样设计）。整段就是 AI 的判断，不要加「」，程序会加"
  },
  "setup": {
    "verdict": "对着上面这台 2015 Intel Mac 的结论：能跑 / 能跑但受限 / 不建议，一句话理由",
    "prereq": [{"tool": "工具名（含版本要求）", "why": "为什么需要", "install": "一行安装方式；无需安装就写'系统自带'"}],
    "steps": [{"n": 1, "title": "动作标题", "detail": "具体做什么（不给大段代码）", "check": "怎么确认这一步成了"}],
    "risks": [{"risk": "这台机器上最容易卡住的地方", "fix": "绕过去的办法"}],
    "timeNeeded": "大概耗时（如 10 分钟）"
  }
}

【仓库材料】
${ctx.head}${ctx.body}`;
}

function buildOwnerPrompt(ctx, user, repos, lang) {
  return `你是一名"读得懂人话"的作品集讲解员。读者是产品/运营背景、会装软件但不想读源码的人。
这次给你的不是单个仓库，而是一位作者的全部公开仓库（共 ${repos.length} 个，按星标排序），他要弄明白：这个人整体在做什么、为什么做、自己该从哪用起。
只依据我给你的材料（README 开头、仓库简介、星标、语言）。

【铁律】
1) 作者原话必须逐字引用，放进 quote 字段，并标 source（格式：仓库名/README.md）；quote 必须能在材料里逐字找到。
2) 作者没写、由你推断的内容只能放进 authorStory 的 text 并标 "inferred": true；aiThread 整段天然是推断。
3) 除 quote 字段外，所有文本里都不允许出现「」这两个符号（程序会自动给推断加）。要强调时用反引号或直接写。
4) 材料没写的就写"作者未说明"，不许编造功能、数据、用户量、效果、公司、价格。星标数是观察事实，可以写；不要拿星标推断质量或商业价值。
5) 语言：${lang === 'en' ? '英文为主' : '中文（简体），专有名词/命令/文件名保留英文原文'}。
6) oneLiner 要像一个人当面给另一个人讲：具体、有画面，不说"赋能""一站式"这类空话。

${MACHINE}

【输出 JSON（只输出 JSON，不要 markdown 代码块）】
{
  "repoNote": "一句话：这个人的作品集现在处于什么状态（在做什么方向、成熟度、是否活跃），依据星标分布与最近更新",
  "products": [
    {"name": "仓库名", "what": "它做什么（2 句以内，人话）", "for": "谁在什么场景会用", "evidence": "仓库名（可带 README 里的关键一句）"}
  ],
  "oneLiner": {
    "oneLiner": "一句话：这个人的作品集整体在解决什么",
    "problems": [{"pain": "他反复在解决的一类难题", "scene": "现实里这个难题的场面"}],
    "whoNeeds": [{"who": "一类具体的人", "trigger": "他会在什么时刻想起要用这些工具"}],
    "story": "180-260 字口语化讲解：先说你会碰到什么麻烦，再说这个人的一堆工具分别接哪一环，最后说边界。不要分点。"
  },
  "authorStory": {
    "discovered": [{"text": "从多个仓库能看出他发现/反复回到什么问题", "quote": "原话，没有就空字符串", "source": "仓库名/README.md 或空", "inferred": false}],
    "need": [{"text": "这对应他自己的什么需求", "quote": "", "source": "", "inferred": false}],
    "thinking": [{"text": "他的设计取舍（跨仓库的共同套路）", "quote": "", "source": "", "inferred": false}],
    "practice": [{"text": "他实际怎么用/怎么验证", "quote": "", "source": "", "inferred": false}],
    "results": [{"text": "结果或尚未验证的部分", "quote": "", "source": "", "inferred": false}],
    "aiThread": "80-140 字推断：把跨仓库透出的思路脉络串起来，不要加「」，程序会加"
  },
  "setup": {
    "verdict": "对着上面这台 2015 Intel Mac 的结论：能跑 / 能跑但受限 / 不建议，一句话理由",
    "prereq": [{"tool": "工具名（含版本要求）", "why": "为什么需要", "install": "一行安装方式；无需安装就写'系统自带'"}],
    "steps": [{"n": 1, "title": "该先装哪个、做什么", "detail": "按依赖顺序给出 3-4 步（不给大段代码），每一步说清用哪个仓库、为什么先它", "check": "怎么确认这一步成了"}],
    "risks": [{"risk": "最容易卡住的地方", "fix": "绕过去的办法"}],
    "timeNeeded": "大概耗时"
  }
}

【材料】
${ctx.head}${ctx.body}`;
}

// ---------- LLM ----------
function stripWrap(v) {
  let t = String(v ?? '').trim();
  const m = t.match(/^「([\s\S]*)」$/);
  if (m) t = m[1].trim();
  return t;
}

function sanitize(d) {
  const walkStory = (arr) => (Array.isArray(arr) ? arr : []).map(it => ({
    ...it,
    text: stripWrap(it?.text),
    inferred: it?.inferred === true || (typeof it?.inferred === 'string' && it.inferred === 'true'),
  }));
  const o = d.oneLiner || {};
  const s = d.setup || {};
  return {
    ...d,
    repoNote: stripWrap(d.repoNote),
    products: (Array.isArray(d.products) ? d.products : []).map(p => ({ ...p, name: stripWrap(p?.name), what: stripWrap(p?.what), for: stripWrap(p?.for) })),
    oneLiner: {
      oneLiner: stripWrap(o.oneLiner),
      story: stripWrap(o.story),
      problems: (Array.isArray(o.problems) ? o.problems : []).map(p => ({ ...p, pain: stripWrap(p?.pain), scene: stripWrap(p?.scene) })),
      whoNeeds: (Array.isArray(o.whoNeeds) ? o.whoNeeds : []).map(p => ({ ...p, who: stripWrap(p?.who), trigger: stripWrap(p?.trigger) })),
    },
    authorStory: {
      ...(d.authorStory || {}),
      ...Object.fromEntries(['discovered', 'need', 'thinking', 'practice', 'results'].map(k => [k, walkStory(d.authorStory?.[k])])),
      aiThread: stripWrap(d.authorStory?.aiThread),
    },
    setup: {
      ...s,
      verdict: stripWrap(s.verdict),
      prereq: (Array.isArray(s.prereq) ? s.prereq : []).map(p => ({ ...p, tool: stripWrap(p?.tool), why: stripWrap(p?.why), install: stripWrap(p?.install) })),
      steps: (Array.isArray(s.steps) ? s.steps : []).map(p => ({ ...p, title: stripWrap(p?.title), detail: stripWrap(p?.detail), check: stripWrap(p?.check) })),
      risks: (Array.isArray(s.risks) ? s.risks : []).map(p => ({ ...p, risk: stripWrap(p?.risk), fix: stripWrap(p?.fix) })),
    },
  };
}

function extractJson(s) {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型没有返回 JSON');
  return JSON.parse(s.slice(start, end + 1));
}

async function callLLMOnce(prompt, apiKey) {
  let r;
  try {
    r = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: '你是严谨的仓库讲解员。只依据给定材料，作者原话必须逐字引用，推断必须用「」标注，只输出 JSON。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: Number(process.env.MAX_TOKENS || 24000),
        reasoning_effort: process.env.REASONING_EFFORT || 'low',
        response_format: { type: 'json_object' },
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    const cause = e.cause ? `${e.cause.code || e.cause.message || e.cause}` : '';
    throw new Error(`连不上模型接口（${e.name}: ${e.message}${cause ? ' / ' + cause : ''}）`);
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    if (r.status === 401) throw new Error('API Key 无效（401），请在设置里换一个 key');
    if (r.status === 402) throw new Error('API 余额不足（402），请充值后再试');
    if (r.status === 429) throw new Error('模型接口限流（429），稍等再试');
    throw new Error(`模型接口错误 ${r.status}: ${txt.slice(0, 200)}`);
  }

  let content = '', usage = null, buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.usage) usage = j.usage;
      const delta = j.choices?.[0]?.delta || {};
      if (delta.content) content += delta.content;
    }
  }
  if (!content.trim()) throw new Error('模型没有返回内容（可能被内容策略拦截）');
  return { data: extractJson(content), usage };
}

async function callLLM(prompt, apiKey) {
  try {
    return await callLLMOnce(prompt, apiKey);
  } catch (e) {
    const transient = /terminated|fetch failed|ECONNRESET|socket|timeout|aborted|network/i.test(e.message);
    if (!transient) throw e;
    console.warn('[llm] 连接中断，重试一次：', e.message);
    await new Promise(r => setTimeout(r, 1200));
    return await callLLMOnce(prompt, apiKey);
  }
}

// ---------- 缓存 ----------
function cacheKey(owner, repo, commit) {
  return path.join(CACHE_DIR, `${owner}__${repo}__${(commit || 'x').slice(0, 10)}.json`);
}
function readCache(k) { try { return JSON.parse(fs.readFileSync(k, 'utf8')); } catch { return null; } }
function writeCache(k, v) { try { fs.writeFileSync(k, JSON.stringify(v)); } catch {} }

// ---------- 历史记录 ----------
function readIndex() {
  try { const a = JSON.parse(fs.readFileSync(HISTORY_INDEX, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeIndex(list) {
  try { fs.writeFileSync(HISTORY_INDEX, JSON.stringify(list.slice(0, 300), null, 1)); } catch {}
}
function saveHistory(out) {
  // 同一仓库同一版本只保留一条：重复点击「去发现」时刷新它的记录，而不是堆一堆重复项
  const prev = readIndex().find(x => x.full_name === out.repo.full_name && x.pushed_at === out.repo.pushed_at);
  const id = prev ? prev.id : `${out.repo.full_name.replace(/\//g, '__')}__${Date.now()}`;
  const stamp = new Date().toISOString();
  out.analyzedAt = stamp;
  fs.writeFileSync(path.join(HISTORY_DIR, id + '.json'), JSON.stringify({ id, savedAt: stamp, data: out }));
  const idx = readIndex().filter(x => x.id !== id);
  idx.unshift({
    id, full_name: out.repo.full_name, html_url: out.repo.html_url, description: out.repo.description,
    stars: out.repo.stars, analyzedAt: out.analyzedAt, pushed_at: out.repo.pushed_at,
    products: Array.isArray(out.products) ? out.products.length : 0,
  });
  writeIndex(idx);
  return id;
}
function loadHistory(id) {
  if (!/^[\w.\-]+$/.test(id)) throw new Error('无效的历史记录 id');
  const f = path.join(HISTORY_DIR, id + '.json');
  if (!fs.existsSync(f)) throw new Error('这条历史记录已经不存在');
  return JSON.parse(fs.readFileSync(f, 'utf8')).data;
}

// ---------- 静态文件 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, 'discover', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'discover'))) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- 主流程 ----------
async function analyzeOwner(owner, apiKey, lang, useCache) {
  const collected = await collectOwner(owner);
  const ctx = buildOwnerContext(collected);
  const latestPush = collected.repos.map(r => r.pushed).filter(Boolean).sort().pop() || 'x';
  const key = path.join(CACHE_DIR, `owner__${owner}__${latestPush.slice(0, 10)}.json`);

  if (useCache) {
    const hit = readCache(key);
    if (hit) {
      const copy = { ...hit, cached: true };
      copy.historyId = saveHistory(copy);
      return copy;
    }
  }
  if (!apiKey) throw new Error('服务端没有可用的 API Key：请在 .env.local 里配置 DEEPSEEK_API_KEY，或在页面右上角填入自己的 key');

  const prompt = buildOwnerPrompt(ctx, collected.user, collected.repos, lang);
  let data, usage;
  try {
    ({ data, usage } = await callLLM(prompt, apiKey));
  } catch (e) {
    if (!/JSON|截断|Expected/.test(e.message)) throw e;
    ({ data, usage } = await callLLM(prompt + '\n\n【注意】上次输出被截断，请精简：每个仓库 what 一句话；作者来路每阶段 2 条以内；确保 JSON 完整闭合。', apiKey));
  }
  const cleaned = sanitize(data);
  const byName = new Map(collected.repos.map(r => [r.name.toLowerCase(), r]));
  cleaned.products = (Array.isArray(cleaned.products) ? cleaned.products : []).map(p => {
    const hit = byName.get(String(p.name || '').toLowerCase().trim());
    return hit ? { ...p, url: hit.url, stars: hit.stars } : p;
  });

  const out = {
    ...cleaned,
    repo: {
      full_name: collected.user.login,
      name: collected.user.name || '',
      html_url: collected.user.html_url,
      description: collected.user.bio || '',
      stars: collected.repos.reduce((a, r) => a + r.stars, 0),
      forks: 0, language: null, license: null,
      pushed_at: latestPush, created_at: collected.user.created_at, topics: [],
      type: 'owner', repoCount: collected.repos.length, followers: collected.user.followers,
    },
    fileCount: collected.repos.length,
    docsUsed: collected.repos.filter(r => r.readme).map(r => r.full_name + '/README.md'),
    usage, cached: false, analyzedAt: new Date().toISOString(),
  };
  writeCache(key, out);
  out.historyId = saveHistory(out);
  return out;
}

async function analyze(input, apiKey, lang, useCache) {
  const parsed = parseRepoUrl(input);
  if (parsed.kind === 'owner') return analyzeOwner(parsed.owner, apiKey, lang, useCache);
  const { owner, repo } = parsed;
  const collected = await collectRepo(owner, repo);
  const ctx = buildContext(collected);
  const key = cacheKey(owner, repo, collected.repo.pushed_at);

  if (useCache) {
    const hit = readCache(key);
    if (hit) {
      const copy = { ...hit, cached: true };
      copy.historyId = saveHistory(copy);
      return copy;
    }
  }
  if (!apiKey) throw new Error('服务端没有可用的 API Key：请在 .env.local 里配置 DEEPSEEK_API_KEY，或在页面右上角填入自己的 key');

  const prompt = buildPrompt(ctx, lang);
  if (process.env.DEBUG_PROMPT) fs.writeFileSync('/tmp/last-prompt.txt', prompt);
  let data, usage;
  try {
    ({ data, usage } = await callLLM(prompt, apiKey));
  } catch (e) {
    if (!/JSON|截断|Expected/.test(e.message)) throw e;
    // 输出被截断时，再要一次更精简的版本
    const retryPrompt = prompt + '\n\n【注意】上一次输出在 JSON 中途被截断。这次务必精简：products 每项 what 一句话；problems 2 条、whoNeeds 2 条；作者来路每个阶段最多 2 条、每条一句话；不要长篇解释。确保 JSON 完整闭合。';
    ({ data, usage } = await callLLM(retryPrompt, apiKey));
  }

  const cleaned = sanitize(data);
  const out = { ...cleaned, repo: collected.repo, fileCount: collected.tree.length, docsUsed: collected.docs.map(d => d.path), usage, cached: false, analyzedAt: new Date().toISOString() };
  writeCache(key, out);
  out.historyId = saveHistory(out);
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, model: LLM_MODEL, key: Boolean(process.env.DEEPSEEK_API_KEY), port: PORT });
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const apiKey = (body.apiKey || '').trim() || process.env.DEEPSEEK_API_KEY;
      const data = await analyze(body.url, apiKey, body.lang || 'zh', body.useCache !== false);
      return sendJson(res, 200, { ok: true, data });
    }
    if (url.pathname === '/api/history' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, items: readIndex() });
    }
    if (url.pathname === '/api/history' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') || '';
      writeIndex(readIndex().filter(x => x.id !== id));
      try { fs.unlinkSync(path.join(HISTORY_DIR, `${id}.json`)); } catch {}
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/history/item' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, data: loadHistory(url.searchParams.get('id') || '') });
    }
    if (url.pathname === '/api/peek' && req.method === 'GET') {
      const c = await collectRepo(parseRepoUrl(url.searchParams.get('url')).owner, parseRepoUrl(url.searchParams.get('url')).repo);
      const ctx = buildContext(c);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`${ctx.head}\n\n${ctx.body.slice(0, 6000)}`);
    }
    if (req.method === 'GET') return serveStatic(req, res);
    sendJson(res, 405, { ok: false, error: '不支持的方法' });
  } catch (e) {
    console.error('[error]', e.message, e.stack?.split('\n')[1] || '');
    sendJson(res, 400, { ok: false, error: e.message || '未知错误' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用：可能已经开着一个 Repo Radar。直接访问 http://127.0.0.1:${PORT} 。`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Repo Radar 已启动 → http://127.0.0.1:${PORT}\n  模型：${LLM_MODEL}   Key：${process.env.DEEPSEEK_API_KEY ? '已加载' : '缺失'}\n`);
});
