'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 「…」 里的是 AI 推断，视觉上要和作者原话区分开
const rich = (s) => esc(s).replace(/「([^「」]{1,400})」/g, '<span class="guess">「$1」</span>');
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const guess = (t) => `<span class="guess">「${esc(t)}」</span>`;
const str = (v) => (typeof v === 'string' ? v.trim() : '');

let state = { data: null };
const LS = {
  key: 'rr.apikey', lang: 'rr.lang', hist: 'rr.history', fresh: 'rr.fresh',
};
const get = (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// ---------- 设置 ----------
$('keyInput').value = get(LS.key);
$('langSelect').value = get(LS.lang, 'zh');
$('settingsBtn').onclick = () => $('settingsPanel').classList.toggle('hidden');
$('keyInput').oninput = (e) => set(LS.key, e.target.value.trim());
$('langSelect').onchange = (e) => set(LS.lang, e.target.value);
$('forceFresh').checked = get(LS.fresh) === '1';
$('forceFresh').onchange = (e) => set(LS.fresh, e.target.checked ? '1' : '0');

// ---------- 历史记录（服务端保存，点开即看） ----------
let historyItems = [];

async function loadHistoryList() {
  try {
    const r = await fetch('/api/history');
    const j = await r.json();
    historyItems = j.items || [];
  } catch { historyItems = []; }
  renderHistoryList();
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderHistoryList() {
  $('historyCount').textContent = historyItems.length ? `${historyItems.length} 条` : '';
  if (!historyItems.length) {
    $('historyList').innerHTML = '<p class="muted hist-empty">还没有历史记录。粘贴一个 GitHub 链接、点「去发现」后会自动存到这里。</p>';
    return;
  }
  $('historyList').innerHTML = historyItems.map(it => `
    <div class="hist-item" data-id="${esc(it.id)}">
      <div class="hist-main">
        <div class="hist-name">${esc(it.full_name)}</div>
        <div class="hist-sub">${esc(fmtDate(it.analyzedAt))} · ★ ${esc(it.stars)} · ${esc(it.products)} 个产物${it.description ? ' · ' + esc(it.description).slice(0, 60) : ''}</div>
      </div>
      <button class="hist-del" data-del="${esc(it.id)}" title="删除这条记录">✕</button>
    </div>`).join('');

  $('historyList').querySelectorAll('.hist-item').forEach(el => {
    el.onclick = (ev) => { if (ev.target.closest('.hist-del')) return; openHistory(el.dataset.id); };
  });
  $('historyList').querySelectorAll('.hist-del').forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      await fetch('/api/history?id=' + encodeURIComponent(btn.dataset.del), { method: 'DELETE' });
      loadHistoryList();
    };
  });
}

// 历史记录弹窗
const historyModal = () => $('historyModal');
function openHistoryModal() {
  historyModal().classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  loadHistoryList();
}
function closeHistoryModal() {
  historyModal().classList.add('hidden');
  document.body.style.overflow = '';
}
$('historyBtn').onclick = openHistoryModal;
$('historyClose').onclick = closeHistoryModal;
$('historyMask').onclick = closeHistoryModal;
document.addEventListener?.('keydown', (e) => {
  if (e.key === 'Escape' && !historyModal().classList.contains('hidden')) closeHistoryModal();
});

async function openHistory(id) {
  try {
    const r = await fetch('/api/history/item?id=' + encodeURIComponent(id));
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || '打开失败');
    closeHistoryModal();
    $('error').classList.add('hidden');
    $('status').classList.add('hidden');
    state.data = j.data;
    render(j.data, 0, true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    showError(e.message);
  }
}

$('exampleChip').onclick = () => {
  $('urlInput').value = 'https://github.com/jiamiaomiao029-gif/liushui-skills';
  $('urlInput').focus();
};

$('pasteBtn').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t) throw new Error('剪贴板是空的');
    const m = t.match(/https?:\/\/github\.com\/[^\s]+/i) || t.match(/[\w.-]+\/[\w.-]+/);
    $('urlInput').value = (m ? m[0] : t).trim().replace(/[).,，。]+$/, '');
    $('urlInput').focus();
  } catch (e) {
    showError('读不到剪贴板（浏览器权限限制）。请手动 ⌘V 粘贴到输入框。');
    $('urlInput').focus();
  }
};

$('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
$('goBtn').onclick = run;
$('againBtn').onclick = () => { $('forceFresh').checked = true; set(LS.fresh, '1'); run(); };

// ---------- 状态 ----------
const TIPS = ['正在抓取仓库信息…', '正在读 README 与说明文档…', '正在整理作者的原话与思路…', '正在对照你的 Mac 判断可行性…', '正在排版结果…'];
let timer = null, tick = null;
function showLoading() {
  $('error').classList.add('hidden');
  $('result').classList.add('hidden');
  $('status').classList.remove('hidden');
  let i = 0, sec = 0;
  $('statusText').textContent = TIPS[0];
  $('stageList').innerHTML = TIPS.map((t, k) => `<li data-k="${k}">${t}</li>`).join('');
  const mark = () => document.querySelectorAll('#stageList li').forEach((li, k) => {
    li.className = k < i ? 'done' : k === i ? 'now' : '';
  });
  mark();
  timer = setInterval(() => { i = Math.min(i + 1, TIPS.length - 1); $('statusText').textContent = TIPS[i]; mark(); }, 6000);
  tick = setInterval(() => {
    sec++;
    const el = $('elapsed');
    if (el) el.textContent = `已等待 ${sec}s · 首次分析通常 40–90 秒，之后同版本仓库走缓存会秒出`;
  }, 1000);
  $('statusText').textContent = TIPS[0];
}
function hideLoading() { clearInterval(timer); clearInterval(tick); $('status').classList.add('hidden'); }
function showError(msg) {
  hideLoading();
  $('result').classList.add('hidden');
  $('error').classList.remove('hidden');
  $('error').innerHTML = `<strong>没成功：</strong> ${esc(msg)}<div class="tiny">可以检查：链接是否公开可访问 · 是不是 github.com · 是否触发了 API 频率限制 · 设置里的 Key 是否有效</div>`;
}

// ---------- 主流程 ----------
async function run() {
  const url = $('urlInput').value.trim();
  if (!url) { showError('先粘贴一个 GitHub 仓库链接。'); return; }
  history.replaceState(null, '', '#url=' + encodeURIComponent(url));
  showLoading();
  const t0 = Date.now();
  try {
    const r = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        apiKey: $('keyInput').value.trim(),
        lang: $('langSelect').value,
        useCache: !$('forceFresh').checked,
      }),
    });
    const j = await r.json().catch(() => ({ ok: false, error: '服务端返回了无法解析的内容' }));
    if (!r.ok || !j.ok) throw new Error(j.error || `请求失败（HTTP ${r.status}）`);
    hideLoading();
    state.data = j.data;
    render(j.data, Math.round((Date.now() - t0) / 1000));
    $('forceFresh').checked = false; set(LS.fresh, '0');
    loadHistoryList();
  } catch (e) {
    showError(e.message || '未知错误');
  }
}

// ---------- 渲染 ----------
function render(d, sec, fromHistory = false) {
  const repo = d.repo || {};
  $('result').classList.remove('hidden');

  const isOwner = repo.type === 'owner';
  $('repoName').textContent = isOwner ? `${repo.full_name}${repo.name ? ' · ' + repo.name : ''} · ${repo.repoCount} 个仓库` : (repo.full_name || '');
  $('repoDesc').textContent = repo.description || '（作者没写简介）';
  $('secTitleText').textContent = isOwner ? '① 这位作者的作品' : '① 仓库里有什么';
  $('repoLink').href = repo.html_url || '#';
  $('cacheNote').textContent = fromHistory ? '从历史记录打开 · 未消耗 token' : d.cached ? '缓存结果' : `本次分析 ${sec}s`;
  const pushed = repo.pushed_at ? new Date(repo.pushed_at).toISOString().slice(0, 10) : '—';
  const badgePairs = isOwner
    ? [['仓库', repo.repoCount], ['★ 合计', repo.stars], ['关注者', repo.followers], ['最近更新', pushed], ['读了', d.fileCount + ' 个 README']]
    : [['★', repo.stars], ['⑂', repo.forks], ['语言', repo.language], ['协议', repo.license || '未声明'], ['最近提交', pushed], ['文件', d.fileCount]];
  $('repoBadges').innerHTML = badgePairs.filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<span class="badge">${esc(k)} <b>${esc(v)}</b></span>`).join('');

  $('repoNote').innerHTML = d.repoNote ? `<span class="note-icon">📌</span> ${rich(d.repoNote)}` : '';

  // 产品卡片
  const products = arr(d.products);
  $('productCount').textContent = products.length ? `共 ${products.length} 个` : '';
  $('productGrid').innerHTML = products.map((p, i) => `
    <article class="card">
      <div class="card-top"><span class="num">${String(i + 1).padStart(2, '0')}</span><h3>${esc(p.name)}</h3>${p.stars ? `<span class="card-star">★${esc(p.stars)}</span>` : ''}</div>
      <p class="card-what">${rich(p.what)}</p>
      ${p.for ? `<p class="card-for"><span>谁用：</span>${rich(p.for)}</p>` : ''}
      ${p.evidence ? `<p class="card-ev">📄 ${esc(p.evidence)}</p>` : ''}
      ${p.url ? `<a class="card-link" href="${esc(p.url)}" target="_blank" rel="noreferrer">打开仓库 ↗</a>` : ''}
    </article>`).join('');

  // 三块内容
  const o = d.oneLiner || {};
  $('oneLiner').innerHTML = rich(str(o.oneLiner) || '（模型没给出这句话，可点“重新分析”）');
  const probs = arr(o.problems);
  $('problems').innerHTML = probs.length ? probs.map(p => `
    <div class="item"><div class="item-h">${rich(p.pain)}</div>
    ${p.scene ? `<div class="item-b">${rich(p.scene)}</div>` : ''}</div>`).join('')
    : '<p class="muted">作者未说明</p>';
  const whos = arr(o.whoNeeds);
  $('whoNeeds').innerHTML = whos.length ? whos.map(w => `
    <div class="item"><div class="item-h">${rich(w.who)}</div>
    ${w.trigger ? `<div class="item-b">${rich(w.trigger)}</div>` : ''}</div>`).join('')
    : '<p class="muted">作者未说明</p>';
  $('storyText').innerHTML = rich(str(o.story));

  // 作者来路
  const as = d.authorStory || {};
  const STAGES = [
    ['discovered', '他发现的问题'], ['need', '这对应他的什么需求'],
    ['thinking', '他怎么想清楚'], ['practice', '他实际怎么跑'], ['results', '跑出来什么结果'],
  ];
  $('storyStages').innerHTML = STAGES.map(([k, label]) => {
    const items = arr(as[k]);
    const body = items.length ? items.map(it => {
      const q = str(it.quote), src = str(it.source);
      return `<div class="stage-item">
        <div class="st-text">${it.inferred ? guess(it.text) : rich(it.text)}</div>
        ${q ? `<blockquote class="orig"><span class="quote-mark">原文</span>${esc(q)}${src ? `<span class="src">（${esc(src)}）</span>` : ''}</blockquote>` : ''}
      </div>`;
    }).join('') : '<div class="muted stage-none">作者在这一步没留下说明</div>';
    return `<div class="stage"><div class="stage-label">${label}</div><div class="stage-body">${body}</div></div>`;
  }).join('');
  if (str(as.aiThread)) {
    $('aiThread').classList.remove('hidden');
    $('aiThread').innerHTML = `<h4>AI 读出的思路脉络</h4><p>${guess(as.aiThread)}</p>
      <p class="tiny">以上不是作者原话，是 AI 根据材料推断的参考线索。</p>`;
  } else $('aiThread').classList.add('hidden');

  // 上手条件
  const s = d.setup || {};
  $('verdict').innerHTML = `<span class="verdict-label">对你的 Mac 来说</span> ${rich(str(s.verdict))}`;
  $('machineTuned').textContent = '已按：MacBook Pro 15" 2015 · Intel i7 · 16GB · macOS 12.7.6 评估';
  $('prereq').innerHTML = arr(s.prereq).map(p => `
    <div class="pre"><div class="pre-name">${esc(p.tool)}</div>
    <div class="pre-why">${rich(p.why)}</div>
    ${p.install ? `<div class="pre-inst"><code>${esc(p.install)}</code></div>` : ''}</div>`).join('') || '<p class="muted">作者未列出前置工具</p>';
  $('steps').innerHTML = arr(s.steps).map((st, i) => `
    <li><div class="step-h">${esc(st.title || `第 ${i + 1} 步`)}</div>
      <div class="step-b">${rich(st.detail)}</div>
      ${st.check ? `<div class="step-check">✅ 检验：${rich(st.check)}</div>` : ''}</li>`).join('') || '<li class="muted">作者未写安装步骤</li>';
  $('risks').innerHTML = arr(s.risks).map(r => `
    <div class="risk"><div class="risk-h">⚠️ ${rich(r.risk)}</div>${r.fix ? `<div class="risk-f">绕法：${rich(r.fix)}</div>` : ''}</div>`).join('') || '<p class="muted">无</p>';
  $('timeNeeded').textContent = s.timeNeeded ? `预计耗时：${s.timeNeeded}` : '';

  $('meta').textContent = `参考了 ${arr(d.docsUsed).length} 个文件：${arr(d.docsUsed).join('、')}　·　分析于 ${new Date(d.analyzedAt || Date.now()).toLocaleString('zh-CN')}`;

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'one'));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', p.id !== 'panel-one'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- tab 切换 ----------
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', p.id !== 'panel-' + t.dataset.tab));
  };
});

// ---------- 复制 Markdown ----------
$('copyMd').onclick = async () => {
  const d = state.data; if (!d) return;
  const o = d.oneLiner || {}, s = d.setup || {}, as = d.authorStory || {};
  const L = [];
  L.push(`# ${d.repo?.full_name}`, '', `> ${d.repo?.description || ''}`, '');
  L.push('## 一句话', o.oneLiner || '', '');
  L.push('### 解决的难题');
  arr(o.problems).forEach(p => L.push(`- **${p.pain}** ${p.scene || ''}`));
  L.push('', '### 什么人需要');
  arr(o.whoNeeds).forEach(p => L.push(`- **${p.who}** ${p.trigger || ''}`));
  L.push('', '## 仓库内容');
  arr(d.products).forEach(p => L.push(`- **${p.name}**：${p.what}（${p.evidence || ''}）`));
  L.push('', '## 作者的来路');
  const names = { discovered: '发现', need: '需求', thinking: '思考', practice: '实践', results: '结果' };
  Object.keys(names).forEach(k => {
    const items = arr(as[k]); if (!items.length) return;
    L.push(`### ${names[k]}`);
    items.forEach(it => { L.push(`- ${it.inferred ? `「${it.text}」` : it.text}`); if (it.quote) L.push(`  > 原文：${it.quote}（${it.source || ''}）`); });
  });
  if (as.aiThread) L.push('', `> AI 推断脉络：${as.aiThread}`);
  L.push('', '## 上手条件与步骤', s.verdict || '');
  arr(s.prereq).forEach(p => L.push(`- 工具：${p.tool} — ${p.why}${p.install ? `（${p.install}）` : ''}`));
  arr(s.steps).forEach((st, i) => L.push(`${i + 1}. ${st.title}：${st.detail}${st.check ? ` ✅ ${st.check}` : ''}`));
  arr(s.risks).forEach(r => L.push(`- ⚠️ ${r.risk} → ${r.fix || ''}`));
  const text = L.join('\n');
  try { await navigator.clipboard.writeText(text); $('copyMd').textContent = '已复制 ✓'; }
  catch { $('copyMd').textContent = '复制失败'; }
  setTimeout(() => { $('copyMd').textContent = '复制为 Markdown'; }, 1800);
};

// ---------- 启动：支持 #url= 直达 ----------

// ---------- 下载查阅（生成 PDF 存到浏览器下载目录） ----------
async function downloadPdf() {
  if (!state.data) return;
  const btn = $('pdfBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在排版…';
  const holder = document.createElement('div');
  try {
    const clone = $('result').cloneNode(true);
    clone.querySelectorAll('.foot-actions, .tabs, #cacheNote').forEach(e => e.remove());
    clone.querySelectorAll('.panel').forEach(p => p.classList.remove('hidden'));
    clone.style.width = '920px';
    clone.style.padding = '10px 18px';
    clone.style.background = '#fff';
    holder.style.cssText = 'position:fixed;inset:0;z-index:9999;overflow:auto;background:#eef1f6;padding:18px 0;display:flex;justify-content:center;align-items:flex-start;';
    clone.style.margin = '0 auto';
    clone.style.boxShadow = '0 4px 30px rgba(0,0,0,.12)';
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:6px 14px;border-radius:999px;font-size:12px;z-index:10000';
    tip.textContent = '正在生成本地 PDF，请稍候…';
    holder.appendChild(clone);
    document.body.appendChild(holder);
    document.body.appendChild(tip);

    if (!window.html2canvas || !window.jspdf) throw new Error('PDF 组件没有加载成功');
    await new Promise(r => setTimeout(r, 60));
    const h = clone.scrollHeight || 2000;
    const scale = Math.max(1, Math.min(2, 15000 / h));
    const canvas = await html2canvas(clone, { scale, backgroundColor: '#ffffff', useCORS: true, windowWidth: 960, logging: false });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const margin = 22;
    const imgW = pw - margin * 2;
    const pxPerPage = Math.floor((ph - margin * 2) / (imgW / canvas.width));
    let y = 0, page = 0;
    while (y < canvas.height) {
      const sliceH = Math.min(pxPerPage, canvas.height - y);
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = sliceH;
      c.getContext('2d').drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
      if (page > 0) pdf.addPage();
      pdf.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', margin, margin, imgW, sliceH * (imgW / canvas.width));
      y += sliceH;
      page += 1;
    }
    const name = (state.data.repo?.full_name || 'repo').replace(/[\\/:*?"<>|]/g, '-');
    pdf.save(`${name}-雷达报告.pdf`);
    btn.textContent = '已存到「下载」 ✓';
  } catch (e) {
    console.error(e);
    if (confirm('自动生成 PDF 失败（' + e.message + '）。改用浏览器打印、手动存成 PDF 吗？')) window.print();
    btn.textContent = label;
  } finally {
    holder.remove();
    document.querySelectorAll('body > div[style*="z-index:10000"]').forEach(e => e.remove());
    setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 2000);
  }
}
$('pdfBtn').onclick = downloadPdf;

loadHistoryList();

(function boot() {
  const h = location.hash.match(/^#url=(.+)$/);
  if (h) {
    $('urlInput').value = decodeURIComponent(h[1]);
    run();
  } else {
    $('urlInput').focus();
  }
})();
