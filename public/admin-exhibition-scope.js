(function () {
  const STORAGE_KEY = 'currentExhibitionId';
  const originalFetch = window.fetch.bind(window);

  function currentScope() {
    return String(localStorage.getItem(STORAGE_KEY) || 'all').trim() || 'all';
  }

  function resolveSecret() {
    const candidates = ['admin-secret', 'secretInput', 'secret'];
    for (const id of candidates) {
      const input = document.getElementById(id);
      if (input && String(input.value || '').trim()) return String(input.value).trim();
    }
    const querySecret = new URLSearchParams(window.location.search).get('secret');
    return String(querySecret || localStorage.getItem('adminSecret') || '').trim();
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : String(input && input.url || '');
    const nextInit = Object.assign({}, init || {});
    if (/\/api\/admin(?:\/|$)/.test(url)) {
      const headers = new Headers(nextInit.headers || (input && input.headers) || {});
      if (!headers.has('x-exhibition-id')) headers.set('x-exhibition-id', currentScope());
      nextInit.headers = headers;
    }
    return originalFetch(input, nextInit);
  };

  async function loadExhibitions(secret) {
    if (!secret) return [];
    const response = await originalFetch('/api/admin/exhibitions', {
      headers: { 'x-admin-secret': secret, 'x-exhibition-id': 'all' }
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => ({}));
    return Array.isArray(data.exhibitions) ? data.exhibitions : [];
  }

  function ensureStyle() {
    if (document.getElementById('molink-exhibition-scope-style')) return;
    const style = document.createElement('style');
    style.id = 'molink-exhibition-scope-style';
    style.textContent = `
      .molink-exhibition-scope { position: sticky; top: 0; z-index: 1200; display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:10px 24px; background:#fffdf9; border-bottom:1px solid rgba(128,106,84,.18); box-shadow:0 5px 18px rgba(80,60,40,.05); font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
      .molink-exhibition-scope__label { font-size:12px; color:#8a7768; letter-spacing:.08em; }
      .molink-exhibition-scope__select { min-width:260px; max-width:520px; padding:8px 34px 8px 12px; border:1px solid #ddd1c6; border-radius:9px; background:#fff; color:#3f352e; font:inherit; font-size:13px; }
      .molink-exhibition-scope__meta { font-size:12px; color:#7b6e65; }
      .molink-exhibition-scope__link { margin-left:auto; padding:7px 12px; border-radius:999px; background:#7a9e7e; color:#fff; text-decoration:none; font-size:12px; }
      @media(max-width:720px){ .molink-exhibition-scope{padding:10px 14px}.molink-exhibition-scope__select{min-width:0;flex:1}.molink-exhibition-scope__link{margin-left:0} }
    `;
    document.head.appendChild(style);
  }

  function statusLabel(status) {
    return ({ live: '进行中', draft: '草稿', archived: '已归档' })[status] || status || '';
  }

  async function mount() {
    if (document.getElementById('molink-exhibition-scope')) return;
    ensureStyle();
    const bar = document.createElement('div');
    bar.id = 'molink-exhibition-scope';
    bar.className = 'molink-exhibition-scope';
    bar.innerHTML = `
      <span class="molink-exhibition-scope__label">展览数据范围</span>
      <select class="molink-exhibition-scope__select" aria-label="展览数据范围"><option value="all">全部展览</option></select>
      <span class="molink-exhibition-scope__meta">载入展览中...</span>
      <a class="molink-exhibition-scope__link" href="/admin/exhibitions">展览管理</a>
    `;
    const anchor = document.querySelector('.header, header, body > nav');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);

    const select = bar.querySelector('select');
    const meta = bar.querySelector('.molink-exhibition-scope__meta');
    select.value = currentScope();
    select.addEventListener('change', () => {
      localStorage.setItem(STORAGE_KEY, select.value || 'all');
      window.location.reload();
    });

    const refresh = async () => {
      const secret = resolveSecret();
      if (!secret) {
        meta.textContent = '输入管理密钥后加载展览';
        return;
      }
      const exhibitions = await loadExhibitions(secret);
      const active = currentScope();
      select.innerHTML = '<option value="all">全部展览</option>' + exhibitions.map(item => {
        const counts = `作品 ${Number(item.artwork_count || 0)} · 订单 ${Number(item.order_count || 0)}`;
        return `<option value="${String(item.id).replace(/"/g, '&quot;')}">${item.name}｜${statusLabel(item.status)}｜${counts}</option>`;
      }).join('');
      if ([...select.options].some(option => option.value === active)) select.value = active;
      else {
        select.value = 'all';
        localStorage.setItem(STORAGE_KEY, 'all');
      }
      const selected = exhibitions.find(item => item.id === select.value);
      meta.textContent = selected
        ? `${statusLabel(selected.status)} · ${selected.venue_name || '未填写场馆'}`
        : `共 ${exhibitions.length} 场展览`;
      window.MolinkExhibitionScope.exhibitions = exhibitions;
      window.dispatchEvent(new CustomEvent('molink:exhibitions-loaded', { detail: { exhibitions, current: selected || null } }));
    };

    bar.refresh = refresh;
    ['admin-secret', 'secretInput', 'secret'].forEach(id => {
      const input = document.getElementById(id);
      if (input) input.addEventListener('change', () => setTimeout(refresh, 0));
    });
    setTimeout(refresh, 0);
  }

  window.MolinkExhibitionScope = {
    mount,
    currentScope,
    resolveSecret,
    exhibitions: []
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
