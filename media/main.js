(function () {
  const vscode = acquireVsCodeApi();

  // ---------- 状态 ----------
  const state = {
    view: 'search',
    shelf: [],
    results: [],
    searching: false,
    inspecting: false,
    inspectError: '',
    reader: null, // { book, chapters, chapterIndex }
    catalogOpen: false,
    loadingChapter: false,
    directOnly: false,
    theme: 'auto',
    downloads: [],
    detail: null, // { book, chapters, loading, error }
    bookmarks: {},
    readerSettings: { fontSize: 16, fontSizeModifier: 'ctrl', bookmarkModifier: 'ctrl' },
  };

  // ---------- 消息通信 ----------
  let seq = 0;
  const pending = new Map();

  function post(type, payload) {
    const requestId = ++seq;
    vscode.postMessage({ type, requestId, payload: payload || {} });
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'downloadProgress' && msg.task) {
      upsertDownload(msg.task);
      renderDownloads();
      if (state.view === 'shelf') renderShelf();
      if (state.view === 'detail') renderDetail();
      return;
    }
    if (msg && msg.type === 'response') {
      const p = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      if (!p) return;
      if (msg.ok) {
        p.resolve(msg.data);
      } else {
        p.reject(new Error(msg.error || '未知错误'));
      }
    }
  });

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function coverChar(title) {
    return esc(title.slice(0, 1));
  }

  // ---------- 图标 ----------
  const ICON_SEARCH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
  const ICON_SHELF =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>';
  const ICON_MENU =
    '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="6" width="16" height="2"></rect><rect x="4" y="11" width="16" height="2"></rect><rect x="4" y="16" width="16" height="2"></rect></svg>';
  const ICON_MORE =
    '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="18" cy="12" r="1.8"></circle></svg>';
  const ICON_BACK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"></path></svg>';
  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path></svg>';
  const ICON_BOOKMARK_EMPTY = '<svg viewBox="0 0 1024 1024" fill="currentColor"><path d="M832 981.333333a21.333333 21.333333 0 0 1-11.333333-3.24l-330-206.266666-330 206.266666a21.333333 21.333333 0 0 1-32.666667-18.093333V181.333333a53.393333 53.393333 0 0 1 53.333333-53.333333h618.666667a53.393333 53.393333 0 0 1 53.333333 53.333333v778.666667a21.333333 21.333333 0 0 1-21.333333 21.333333z m-341.333333-256a21.333333 21.333333 0 0 1 11.333333 3.24l308.666667 192.933334V181.333333a10.666667 10.666667 0 0 0-10.666667-10.666666H181.333333a10.666667 10.666667 0 0 0-10.666666 10.666666v740.173334l308.666666-192.933334a21.333333 21.333333 0 0 1 11.333334-3.24z m448 64V96a53.393333 53.393333 0 0 0-53.333334-53.333333H320a21.333333 21.333333 0 0 0 0 42.666666h565.333333a10.666667 10.666667 0 0 1 10.666667 10.666667v693.333333a21.333333 21.333333 0 0 0 42.666667 0z"></path></svg>';
  const ICON_BOOKMARK_FILLED = '<svg viewBox="0 0 1024 1024" fill="currentColor"><path d="M853.333333 181.333333v778.666667a21.333333 21.333333 0 0 1-32.666666 18.093333l-330-206.266666-330 206.266666a21.333333 21.333333 0 0 1-32.666667-18.093333V181.333333a53.393333 53.393333 0 0 1 53.333333-53.333333h618.666667a53.393333 53.393333 0 0 1 53.333333 53.333333z m32-138.666666H320a21.333333 21.333333 0 0 0 0 42.666666h565.333333a10.666667 10.666667 0 0 1 10.666667 10.666667v693.333333a21.333333 21.333333 0 0 0 42.666667 0V96a53.393333 53.393333 0 0 0-53.333334-53.333333z"></path></svg>';
  const ICON_SETTINGS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';

  // ---------- 骨架 ----------
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-shell">
      <div class="view" id="view-search">
        <div class="search-bar top">
          <input id="search-input" type="text" placeholder="搜索书名，或粘贴网页地址" />
          <button id="search-btn" class="btn primary">搜索</button>
        </div>
        <div id="search-list" class="list web-list"></div>
      </div>

      <div class="view hidden" id="view-shelf">
        <div class="page-header shelf-head">
          <div>
            <h1>书架</h1>
            <div class="sub">收藏的小说都在这里</div>
          </div>
          <button id="open-downloads" class="shelf-dl-btn" type="button" title="下载管理">${ICON_DOWNLOAD}</button>
        </div>
        <div id="shelf-list" class="list"></div>
      </div>

      <div class="view hidden" id="view-downloads">
        <div class="page-header dl-head">
          <button id="downloads-back" class="dl-back-btn" type="button" title="返回书架">${ICON_BACK}</button>
          <h1>下载管理</h1>
        </div>
        <div id="download-list" class="list"></div>
      </div>

      <div class="view hidden" id="view-detail">
        <div class="page-header dl-head">
          <button id="detail-back" class="dl-back-btn" type="button" title="返回">${ICON_BACK}</button>
          <h1 id="detail-title">书籍详情</h1>
        </div>
        <div id="detail-body" class="detail-body"></div>
      </div>

      <div class="view hidden" id="view-settings">
        <div class="page-header">
          <h1>设置</h1>
          <div class="sub" id="theme-sub">界面跟随编辑器主题</div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">外观</div>
          <div class="setting-row theme-row">
            <div>
              <div class="setting-label">界面主题</div>
            </div>
            <div class="theme-switch" id="theme-switch">
              <button type="button" class="theme-btn active" data-theme="auto">跟随</button>
              <button type="button" class="theme-btn" data-theme="light">浅色</button>
              <button type="button" class="theme-btn" data-theme="dark">深色</button>
            </div>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">数据</div>
          <div class="setting-row theme-row">
            <div>
              <div class="setting-label">数据存储路径</div>
              <p class="setting-desc">书架、阅读进度、界面主题等偏好会保存到这个目录下的 moyu-data.json，留空则与下载存储路径一致。换设备或换软件时，指向同一目录并点「读取数据」即可载入本机该目录下的数据。</p>
            </div>
            <input id="data-path" type="text" spellcheck="false" placeholder="留空则使用下载存储路径" />
            <div class="data-load-line">
              <button id="data-import" class="btn primary" type="button">读取数据</button>
              <span id="data-hint" class="setting-desc"></span>
            </div>
            <p class="setting-desc error-text hidden" id="data-error"></p>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">阅读</div>
          <div class="setting-row theme-row">
            <div class="setting-label">正文文字大小</div>
            <div class="font-setting-line">
              <input id="font-size" type="number" min="12" max="32" step="1" />
              <span>px</span>
              <span id="font-preview" class="font-preview">预览文字</span>
            </div>
          </div>
          <div class="setting-row theme-row">
            <div class="setting-label">修改字体大小快捷键</div>
            <select id="font-modifier" class="setting-select">
              <option value="ctrl">Ctrl + 滚轮</option>
              <option value="alt">Alt + 滚轮</option>
              <option value="shift">Shift + 滚轮</option>
            </select>
          </div>
          <div class="setting-row theme-row">
            <div class="setting-label">添加书签快捷键</div>
            <select id="bookmark-modifier" class="setting-select">
              <option value="ctrl">Ctrl + S</option>
              <option value="alt">Alt + S</option>
              <option value="shift">Shift + S</option>
            </select>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">下载</div>
          <div class="setting-row theme-row">
            <div>
              <div class="setting-label">下载路径</div>
              <p class="setting-desc">每本书会在这个目录下建立文件夹：assets 存封面和作者等信息，cache 存目录与阅读位置（30 天），MainTXT 存正文。默认是文档目录下的「摸鱼小说」。</p>
            </div>
            <input id="download-path" type="text" spellcheck="false" />
            <p class="setting-desc error-text hidden" id="download-error"></p>
          </div>
          <div class="setting-row theme-row">
            <label class="check-row">
              <input id="auto-download" type="checkbox" />
              <span>开启自动下载</span>
            </label>
            <p class="setting-desc">勾选后，每次读到的正文都会保存到下载路径。已经下载过的章节会直接从本地打开。</p>
          </div>
        </div>
      </div>

      <div class="reader hidden" id="reader">
        <div class="reader-top">
          <button class="back reader-back-icon" id="reader-back" title="返回">${ICON_BACK}</button>
          <div class="rt-title" id="reader-title"></div>
          <button type="button" class="back reader-bookmark" id="reader-bookmark" title="添加书签">${ICON_BOOKMARK_EMPTY}</button>
          <button type="button" class="back" id="reader-shelf">加入书架</button>
          <button type="button" class="back" id="reader-catalog">目录</button>
        </div>
        <div class="reader-body" id="reader-body">
          <div class="chapter-title" id="chapter-title"></div>
          <div class="reader-content" id="reader-content"></div>
        </div>
        <div class="reader-bottom">
          <button class="btn" id="prev-chapter">上一章</button>
          <div class="spacer" id="chapter-pos"></div>
          <button class="btn" id="next-chapter">下一章</button>
        </div>
      </div>

      <div class="catalog-overlay hidden" id="catalog">
        <div class="catalog-head">
          <span>目录</span>
          <button class="back" id="catalog-close">关闭</button>
        </div>
        <div class="catalog-list" id="catalog-list"></div>
      </div>

      <div class="bottom-nav">
        <div class="nav-item" data-view="search">${ICON_SEARCH}<span>搜索</span></div>
        <div class="nav-item" data-view="shelf">${ICON_SHELF}<span>书架</span></div>
        <div class="nav-item" data-view="settings">${ICON_SETTINGS}<span>设置</span></div>
      </div>
    </div>
  `;

  const $ = (id) => document.getElementById(id);
  const els = {
    searchView: $('view-search'),
    shelfView: $('view-shelf'),
    downloadsView: $('view-downloads'),
    detailView: $('view-detail'),
    settingsView: $('view-settings'),
    searchList: $('search-list'),
    shelfList: $('shelf-list'),
    downloadList: $('download-list'),
    detailBody: $('detail-body'),
    detailTitle: $('detail-title'),
    dataPath: $('data-path'),
    dataError: $('data-error'),
    dataImport: $('data-import'),
    dataHint: $('data-hint'),
    fontSize: $('font-size'),
    fontPreview: $('font-preview'),
    fontModifier: $('font-modifier'),
    bookmarkModifier: $('bookmark-modifier'),
    reader: $('reader'),
    readerTitle: $('reader-title'),
    readerBody: $('reader-body'),
    chapterTitle: $('chapter-title'),
    readerContent: $('reader-content'),
    chapterPos: $('chapter-pos'),
    catalog: $('catalog'),
    catalogList: $('catalog-list'),
  };

  // ---------- 渲染 ----------
  function coverHtml(b, cls) {
    if (b.coverUrl) {
      return `<div class="${cls} has-img"><img src="${esc(b.coverUrl)}" alt="" /></div>`;
    }
    return `<div class="${cls}">${coverChar(b.title)}</div>`;
  }

  function searchBookCard(b) {
    const inShelf = state.shelf.some((it) => it.book.id === b.id);
    const shelfBtn = inShelf
      ? '<button type="button" class="book-menu-item" disabled>已在书架</button>'
      : '<button type="button" class="book-menu-item" data-action="shelf">加入书架</button>';
    return `
      <div class="book-card" data-id="${esc(b.id)}">
        ${coverHtml(b, 'book-cover')}
        <div class="book-meta">
          <p class="title">${esc(b.title)}</p>
          <p class="author">作者：${esc(b.author || '未知')}</p>
          <p class="author">类型：${esc(b.category || '网络小说')} · ${esc(b.wordCount || '')}</p>
          <p class="desc">${esc(b.description || '已识别为小说')}</p>
        </div>
        <div class="book-actions">
          <button class="btn primary" data-action="enter">进入</button>
        </div>
        <div class="book-menu">
          <button class="book-menu-btn" type="button" data-action="menu" title="更多">${ICON_MENU}</button>
          <div class="book-menu-pop hidden">
            <button type="button" class="book-menu-item" data-action="read">开始阅读</button>
            ${shelfBtn}
          </div>
        </div>
      </div>`;
  }

  function webResultCard(r) {
    return `
      <div class="web-result" data-url="${esc(r.url)}">
        <div class="web-title">${esc(r.title)}</div>
        <div class="web-snippet">${esc(r.snippet)}</div>
        <div class="web-host">${esc(r.host)}</div>
      </div>`;
  }

  function renderWebResults(results, searching, inspecting) {
    if (searching) {
      els.searchList.innerHTML = state.directOnly
        ? '<div class="loading">正在打开该网页…</div>'
        : '<div class="loading">搜索中…</div>';
      return;
    }
    if (!results.length && !inspecting) {
      els.searchList.innerHTML =
        '<div class="empty"><div class="big">🔍</div><p>没有找到相关结果</p><p>换个关键词试试吧</p></div>';
      return;
    }
    const seen = new Set();
    const books = [];
    results.forEach((r) => {
      if (!r.isBook || !r.book || seen.has(r.book.id)) return;
      seen.add(r.book.id);
      books.push(r.book);
    });
    const webs = results.filter((r) => !r.isBook);
    let html = '';
    if (state.inspectError) {
      html += `<div class="error-text">${esc(state.inspectError)}</div>`;
    }
    if (inspecting) {
      html += state.directOnly
        ? '<div class="loading">正在识别这个网页…</div>'
        : '<div class="loading">正在打开网页，识别哪些是小说…</div>';
      html += webs.map(webResultCard).join('');
    } else {
      if (books.length) {
        html += '<div class="result-label">识别到的小说</div>';
        html += books.map(searchBookCard).join('');
      }
      if (webs.length) {
        html += `<div class="result-label">${books.length ? '其他网页' : '没有识别到小说，下面是其他网页'}</div>`;
        html += webs.map(webResultCard).join('');
      }
    }
    els.searchList.innerHTML = html;
  }

  function renderShelf() {
    if (!state.shelf.length) {
      els.shelfList.innerHTML =
        '<div class="empty"><div class="big">📚</div><p>书架还是空的</p><p>去搜索页找一本喜欢的小说加入书架吧</p></div>';
      return;
    }
    els.shelfList.innerHTML = state.shelf
      .map((item) => {
        const b = item.book;
        const idx = item.lastReadChapterIndex || 0;
        return `
        <div class="book-card" data-id="${esc(b.id)}">
          ${coverHtml(b, 'book-cover')}
          <div class="book-meta">
            <p class="title">${esc(b.title)}</p>
            <p class="author">作者：${esc(b.author || '未知')}</p>
            <p class="progress-line">${idx > 0 ? '读到第 ' + (idx + 1) + ' 章' : '尚未开始阅读'}</p>
          </div>
          <div class="book-actions">
            <button class="btn primary" data-action="enter">进入</button>
          </div>
          <div class="book-menu">
            <button class="book-menu-btn" type="button" data-action="menu" title="更多">${ICON_MENU}</button>
            <div class="book-menu-pop hidden">
              <button type="button" class="book-menu-item" data-action="read">${idx > 0 ? '继续阅读' : '开始阅读'}</button>
              ${downloadMenuItems(b.id)}
              <button type="button" class="book-menu-item danger" data-action="remove">移除</button>
            </div>
          </div>
        </div>`;
      })
      .join('');
  }

  function downloadTask(bookId) {
    return state.downloads.find((task) => task.bookId === bookId);
  }

  function shelfDownloadLabel(bookId) {
    const task = downloadTask(bookId);
    if (!task) return '下载';
    if (task.status === 'running' || task.status === 'queued') return '下载中';
    if (task.status === 'paused') return '继续下载';
    if (task.status === 'done') return '已下载';
    return '下载';
  }

  function downloadMenuItems(bookId) {
    const task = downloadTask(bookId);
    const downloading = task && (task.status === 'running' || task.status === 'queued');
    if (downloading) {
      return '<button type="button" class="book-menu-item" data-action="pause">暂停下载</button>';
    }
    return `<button type="button" class="book-menu-item" data-action="download">${shelfDownloadLabel(bookId)}</button>`;
  }

  function upsertDownload(task) {
    const index = state.downloads.findIndex((item) => item.bookId === task.bookId);
    if (index >= 0) state.downloads[index] = task;
    else state.downloads.unshift(task);
  }

  function renderDownloads() {
    if (!state.downloads.length) {
      els.downloadList.innerHTML =
        '<div class="empty"><div class="big">↓</div><p>还没有下载任务</p><p>在书架上点一本书的下载按钮</p></div>';
      return;
    }
    els.downloadList.innerHTML = state.downloads
      .map((task) => {
        const total = task.done + task.pending;
        const percent = total > 0 ? Math.round((task.done / total) * 100) : 0;
        const status =
          task.status === 'paused'
            ? '已暂停 · 已下载 ' + task.done + ' / 未下载 ' + task.pending
            : task.status === 'error'
              ? esc(task.error || '下载中断')
              : task.total === 0 && task.status !== 'done'
                ? '正在读取目录…'
                : '已下载 ' + task.done + ' / 未下载 ' + task.pending;
        const busy = task.status === 'running' || task.status === 'queued';
        return `
          <div class="dl-card" data-id="${esc(task.bookId)}">
            <div class="dl-main">
              <div class="dl-title">${esc(task.title || '未命名小说')}</div>
              <div class="dl-author">${esc(task.author || '')}</div>
              <div class="dl-bar"><div class="dl-bar-fill" style="width:${percent}%"></div></div>
              <div class="dl-meta">${status}</div>
            </div>
            <div class="dl-menu">
              <button class="dl-more-btn" type="button" data-action="dl-menu" title="更多">${ICON_MORE}</button>
              <div class="dl-menu-pop hidden">
                ${
                  busy
                    ? '<button type="button" class="book-menu-item" data-action="pause">暂停下载</button>'
                    : '<button type="button" class="book-menu-item" data-action="dl-retry">从出错章节重新下载</button>'
                }
                <button type="button" class="book-menu-item danger" data-action="dl-remove"${busy ? ' disabled' : ''}>移除</button>
              </div>
            </div>
          </div>`;
      })
      .join('');
  }

  async function pauseDownload(bookId) {
    const task = await post('pauseDownload', { bookId });
    upsertDownload(task);
    renderDownloads();
    renderShelf();
    if (state.view === 'detail') renderDetail();
  }

  async function retryDownload(bookId) {
    const task = await post('retryDownload', { bookId });
    upsertDownload(task);
    renderDownloads();
    renderShelf();
  }

  async function removeDownload(bookId) {
    const tasks = await post('removeDownload', { bookId });
    state.downloads = Array.isArray(tasks) ? tasks : state.downloads.filter((item) => item.bookId !== bookId);
    renderDownloads();
    renderShelf();
  }

  function switchView(view) {
    state.view = view;
    els.searchView.classList.toggle('hidden', view !== 'search');
    els.shelfView.classList.toggle('hidden', view !== 'shelf');
    els.downloadsView.classList.toggle('hidden', view !== 'downloads');
    els.detailView.classList.toggle('hidden', view !== 'detail');
    els.settingsView.classList.toggle('hidden', view !== 'settings');
    const nav = view === 'downloads' || view === 'detail' ? 'shelf' : view;
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === nav);
    });
    if (view === 'downloads') renderDownloads();
    if (view === 'detail') renderDetail();
  }

  function renderDetail() {
    const d = state.detail;
    if (!d || !d.book) {
      els.detailBody.innerHTML = '<div class="empty"><p>没有选中书籍</p></div>';
      return;
    }
    const b = d.book;
    els.detailTitle.textContent = b.title || '书籍详情';
    const inShelf = state.shelf.some((it) => it.book.id === b.id);
    const task = downloadTask(b.id);
    const downloading = task && (task.status === 'running' || task.status === 'queued');
    const chapters = Array.isArray(d.chapters) ? d.chapters.slice(0, 10) : [];
    const marked = state.bookmarks[b.id] || [];
    const chapterGrid = chapters.length
      ? chapters
          .map(
            (c, i) =>
              `<button type="button" class="detail-chapter" data-action="detail-chapter" data-index="${i}">${esc(c.title)}</button>`
          )
          .join('')
      : d.loading
        ? '<div class="loading">正在读取目录…</div>'
        : `<div class="error-text">${esc(d.error || '暂时没有章节')}</div>`;
    const bookmarkGrid = marked.length
      ? marked.map((item) => `<button type="button" class="detail-chapter bookmark-chapter" data-action="bookmark-chapter" data-index="${item.chapterIndex}">${esc(item.title)}</button>`).join('')
      : '<div class="setting-desc">暂无书签章节</div>';
    els.detailBody.dataset.id = b.id;
    els.detailBody.innerHTML = `
      <div class="detail-top">
        ${coverHtml(b, 'detail-cover')}
        <div class="detail-info">
          <div class="detail-name">${esc(b.title)}</div>
          <div class="detail-row">作者：${esc(b.author || '未知')}</div>
          <div class="detail-row">类型：${esc(b.category || '网络小说')}</div>
          <div class="detail-row">更新时间：${esc(b.updateTime || '暂无')}</div>
          <div class="detail-row">最新章节：${esc(b.latestChapter || '暂无')}</div>
          <div class="detail-row">章节数：${esc(b.wordCount || (d.chapters && d.chapters.length ? d.chapters.length + ' 章' : '暂无'))}</div>
          <p class="detail-desc">${esc(b.description || '')}</p>
          <div class="detail-actions">
            <button class="btn primary" data-action="read">开始阅读</button>
            ${
              downloading
                ? '<button class="btn" data-action="pause">暂停下载</button>'
                : `<button class="btn" data-action="download">${shelfDownloadLabel(b.id)}</button>`
            }
            ${
              inShelf
                ? '<button class="btn danger" data-action="remove">移除</button>'
                : '<button class="btn" data-action="shelf">加入书架</button>'
            }
          </div>
        </div>
      </div>
      <div class="detail-section-title">前十章</div>
      <div class="detail-chapter-grid">${chapterGrid}</div>
      <div class="detail-section-title">书签章节</div>
      <div class="detail-chapter-grid">${bookmarkGrid}</div>
      <div class="detail-footer">
        <button class="btn primary" data-action="detail-catalog" ${!d.chapters || !d.chapters.length ? 'disabled' : ''}>目录</button>
      </div>`;
  }

  async function openDetail(book) {
    state.detailBack = state.view === 'search' ? 'search' : 'shelf';
    state.detail = { book, chapters: [], loading: true, error: '' };
    switchView('detail');
    renderDetail();
    try {
      const resp = await post('getChapters', {
        bookId: book.id,
        source: book.source,
        catalogUrl: book.catalogUrl || '',
        pageUrl: book.pageUrl || '',
        listPages: book.listPages || [],
      });
      if (!state.detail || state.detail.book.id !== book.id) return;
      const chapters = Array.isArray(resp) ? resp : (resp && resp.chapters) || [];
      const complete = Array.isArray(resp) ? true : !resp || resp.complete !== false;
      if (!book.latestChapter && chapters.length) {
        book.latestChapter = chapters[chapters.length - 1].title;
      }
      if (complete && chapters.length) {
        book.wordCount = chapters.length + ' 章';
      } else if (!book.wordCount && chapters.length) {
        book.wordCount = chapters.length + ' 章';
      }
      state.detail = { book, chapters, complete, loading: false, error: '' };
    } catch (e) {
      if (!state.detail || state.detail.book.id !== book.id) return;
      state.detail = { book, chapters: [], loading: false, error: e.message || '读取目录失败' };
    }
    renderDetail();
  }

  async function openDownloads() {
    switchView('downloads');
    try {
      const tasks = await post('listDownloads', {});
      if (Array.isArray(tasks)) state.downloads = tasks;
    } catch (e) {
      els.downloadList.innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
      return;
    }
    renderDownloads();
  }

  async function startBookDownload(book) {
    switchView('downloads');
    upsertDownload({
      bookId: book.id,
      title: book.title,
      author: book.author,
      done: 0,
      pending: 0,
      total: 0,
      status: 'queued',
      error: '',
    });
    renderDownloads();
    try {
      const task = await post('startDownload', { book });
      upsertDownload(task);
    } catch (e) {
      upsertDownload({
        bookId: book.id,
        title: book.title,
        author: book.author,
        done: 0,
        pending: 0,
        total: 0,
        status: 'error',
        error: e.message || '没有开始下载',
      });
    }
    renderDownloads();
    renderShelf();
  }

  // ---------- 动作 ----------
  let searchToken = 0;

  function pageUrlFromQuery(q) {
    const text = String(q || '').trim();
    if (!text || /\s/.test(text)) return '';
    let raw = text;
    if (!/^https?:\/\//i.test(raw)) {
      if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i.test(raw)) return '';
      raw = 'https://' + raw;
    }
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (!u.hostname || u.hostname.indexOf('.') < 0) return '';
      return u.href;
    } catch (e) {
      return '';
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return url;
    }
  }

  async function doSearch() {
    const q = $('search-input').value.trim();
    if (!q) return;
    const token = ++searchToken;
    const pageUrl = pageUrlFromQuery(q);
    state.directOnly = !!pageUrl;
    state.searching = true;
    state.inspecting = false;
    state.inspectError = '';
    renderWebResults([], true, false);
    try {
      if (pageUrl) {
        state.results = [
          {
            title: pageUrl,
            url: pageUrl,
            snippet: '只打开并识别这个网页',
            host: hostOf(pageUrl),
            isBook: false,
          },
        ];
      } else {
        state.results = await post('webSearch', { query: q });
      }
    } catch (e) {
      if (token !== searchToken) return;
      state.results = [];
      els.searchList.innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
      state.searching = false;
      return;
    }
    if (token !== searchToken) return;
    state.searching = false;
    state.inspecting = true;
    renderWebResults(state.results, false, true);
    try {
      const slim = state.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        host: r.host,
      }));
      const inspected = await post('inspectWeb', { results: slim });
      if (token !== searchToken) return;
      state.results = inspected;
    } catch (e) {
      if (token !== searchToken) return;
      state.inspectError = e.message || '识别小说网页失败';
    }
    state.inspecting = false;
    renderWebResults(state.results, false, false);
  }

  function refreshSearch() {
    if (state.searching || state.inspecting || state.results.length || state.inspectError) {
      renderWebResults(state.results, state.searching, state.inspecting);
    }
  }

  async function removeFromShelf(bookId) {
    state.shelf = await post('removeBook', { bookId });
    renderShelf();
    refreshSearch();
    updateReaderShelfBtn();
  }

  async function addToShelf(book) {
    state.shelf = await post('saveBook', { book });
    renderShelf();
    refreshSearch();
    updateReaderShelfBtn();
  }

  function findBook(bookId) {
    const inShelf = state.shelf.find((it) => it.book.id === bookId);
    if (inShelf) return inShelf.book;
    for (const r of state.results) {
      if (r.book && r.book.id === bookId) return r.book;
    }
    if (state.detail && state.detail.book && state.detail.book.id === bookId) return state.detail.book;
    if (state.reader && state.reader.book.id === bookId) return state.reader.book;
    return undefined;
  }

  function updateReaderShelfBtn() {
    const btn = $('reader-shelf');
    const book = state.reader && state.reader.book;
    if (!book) {
      btn.textContent = '加入书架';
      btn.disabled = true;
      return;
    }
    const inShelf = state.shelf.some((it) => it.book.id === book.id);
    btn.textContent = inShelf ? '已在书架' : '加入书架';
    btn.disabled = inShelf;
  }

  async function openReader(book, startIndex) {
    els.searchView.classList.add('hidden');
    els.shelfView.classList.add('hidden');
    els.downloadsView.classList.add('hidden');
    els.detailView.classList.add('hidden');
    els.settingsView.classList.add('hidden');
    els.reader.classList.remove('hidden');
    els.readerTitle.textContent = book.title;
    els.chapterTitle.textContent = book.source === 'web' ? '正在翻页读取全部章节…' : '正在读取目录…';
    els.readerContent.textContent = '';
    state.reader = { book, chapters: [], chapterIndex: 0 };
    updateReaderShelfBtn();

    try {
      let chapters;
      let complete = true;
      if (
        state.detail &&
        state.detail.book &&
        state.detail.book.id === book.id &&
        state.detail.chapters &&
        state.detail.chapters.length
      ) {
        chapters = state.detail.chapters;
        complete = state.detail.complete !== false;
      } else {
        const resp = await post('getChapters', {
          bookId: book.id,
          source: book.source,
          catalogUrl: book.catalogUrl || '',
          pageUrl: book.pageUrl || '',
          listPages: book.listPages || [],
        });
        chapters = Array.isArray(resp) ? resp : (resp && resp.chapters) || [];
        complete = Array.isArray(resp) ? true : !resp || resp.complete !== false;
      }
      if (!chapters.length) {
        throw new Error('没有识别到章节');
      }
      if (complete && chapters.length) {
        book.wordCount = chapters.length + ' 章';
      }
      let chapterIndex = typeof startIndex === 'number' ? startIndex : -1;
      if (chapterIndex < 0) {
        const progress = await post('getProgress', { bookId: book.id });
        chapterIndex = 0;
        if (progress && progress.chapterId) {
          const found = chapters.findIndex((c) => c.id === progress.chapterId || c.url === progress.chapterId);
          chapterIndex = found >= 0 ? found : progress.chapterIndex || 0;
        } else if (progress && progress.chapterIndex != null) {
          chapterIndex = progress.chapterIndex;
        }
      }
      if (chapterIndex < 0 || chapterIndex >= chapters.length) chapterIndex = 0;

      state.reader = { book, chapters, chapterIndex };
      const allBookmarks = await post('getBookmarks', {});
      state.bookmarks = allBookmarks || {};
      state.catalogOpen = false;
      renderCatalog();
      await loadChapter(chapterIndex);
    } catch (e) {
      els.chapterTitle.textContent = '';
      els.readerContent.innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
      els.chapterPos.textContent = '';
    }
  }

  async function loadChapter(index) {
    const r = state.reader;
    if (!r) return;
    if (index < 0 || index >= r.chapters.length) return;
    r.chapterIndex = index;
    state.loadingChapter = true;
    els.readerContent.textContent = '';
    els.chapterTitle.textContent = '加载中…';
    updateChapterPos();

    try {
      const content = await post('getContent', {
        bookId: r.book.id,
        source: r.book.source,
        chapterId: r.chapters[index].id,
        chapterUrl: r.chapters[index].url || r.chapters[index].id,
        chapterTitle: r.chapters[index].title,
        bookTitle: r.book.title,
      });
      els.chapterTitle.textContent = content.title;
      els.readerContent.textContent = content.content;
      applyReaderFontSize();
      $('reader-body').scrollTop = 0;
      await post('saveProgress', {
        bookId: r.book.id,
        chapterIndex: index,
        chapterId: r.chapters[index].id,
      });
      const item = state.shelf.find((it) => it.book.id === r.book.id);
      if (item) item.lastReadChapterIndex = index;
    } catch (e) {
      els.readerContent.textContent = '';
      els.chapterTitle.textContent = '';
      els.readerContent.innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
    }
    state.loadingChapter = false;
    updateChapterPos();
    renderCatalog();
  }

  function updateChapterPos() {
    const r = state.reader;
    if (!r) return;
    els.chapterPos.textContent = `${r.chapterIndex + 1} / ${r.chapters.length}`;
    const marked = (state.bookmarks[r.book.id] || []).some((item) => item.chapterId === r.chapters[r.chapterIndex].id);
    $('reader-bookmark').innerHTML = marked ? ICON_BOOKMARK_FILLED : ICON_BOOKMARK_EMPTY;
    $('reader-bookmark').title = marked ? '取消书签' : '添加书签';
    $('prev-chapter').disabled = r.chapterIndex <= 0;
    $('next-chapter').disabled = r.chapterIndex >= r.chapters.length - 1;
  }

  function renderCatalog() {
    const r = state.reader;
    if (!r) return;
    const word = String((r.book && r.book.wordCount) || '');
    const expected = /章/.test(word) ? parseInt(word.replace(/[^\d]/g, ''), 10) || 0 : 0;
    const short = expected > r.chapters.length + 5;
    const head = els.catalog.querySelector('.catalog-head span');
    if (head) {
      head.textContent = short ? '目录 ' + r.chapters.length + ' / 约 ' + expected : '目录 ' + r.chapters.length;
    }
    const note = short
      ? '<div class="catalog-note">下拉框标注约 ' +
        expected +
        ' 章，这次打开目录页后读到 ' +
        r.chapters.length +
        ' 章。剩下的分页没有返回章节链接。</div>'
      : '';
    els.catalogList.innerHTML =
      note +
      r.chapters
        .map((c, i) => {
          const marked = (state.bookmarks[r.book.id] || []).some((item) => item.chapterId === c.id);
          return `<div class="catalog-item ${i === r.chapterIndex ? 'active' : ''}" data-index="${i}"><span>${esc(c.title)}</span><button type="button" class="catalog-bookmark ${marked ? 'marked' : ''}" data-action="catalog-bookmark" data-index="${i}" title="${marked ? '取消书签' : '添加书签'}">${marked ? ICON_BOOKMARK_FILLED : ICON_BOOKMARK_EMPTY}</button></div>`;
        })
        .join('');
  }

  function closeReader() {
    state.reader = null;
    els.reader.classList.add('hidden');
    els.catalog.classList.add('hidden');
    state.catalogOpen = false;
    if (state.detail && state.detail.book) {
      switchView('detail');
      renderDetail();
      return;
    }
    switchView(state.view === 'shelf' ? 'shelf' : 'search');
    renderShelf();
  }

  function applyReaderFontSize() {
    const size = state.readerSettings.fontSize;
    els.readerContent.style.fontSize = size + 'px';
    els.chapterTitle.style.fontSize = Math.max(16, size + 2) + 'px';
    if (els.fontSize) els.fontSize.value = size;
    if (els.fontPreview) els.fontPreview.style.fontSize = size + 'px';
  }

  function modifierPressed(event, modifier) {
    return modifier === 'ctrl' ? event.ctrlKey : modifier === 'alt' ? event.altKey : event.shiftKey;
  }

  async function saveReaderSettings() {
    try {
      state.readerSettings = await post('saveReaderSettings', {
        fontSize: Number(els.fontSize.value),
        fontSizeModifier: els.fontModifier.value,
        bookmarkModifier: els.bookmarkModifier.value,
      });
      applyReaderFontSize();
    } catch (e) {
      els.fontSize.value = state.readerSettings.fontSize;
    }
  }

  async function toggleBookmarkAt(index) {
    const r = state.reader;
    if (!r || !r.chapters[index]) return;
    const chapter = r.chapters[index];
    try {
      state.bookmarks[r.book.id] = await post('toggleBookmark', {
        bookId: r.book.id,
        chapterId: chapter.id,
        title: chapter.title,
        chapterIndex: index,
      });
      updateChapterPos();
      renderCatalog();
      if (state.detail) renderDetail();
    } catch (e) {
      // 保存失败时保留界面上的原有书签。
    }
  }

  async function toggleCurrentBookmark() {
    const r = state.reader;
    if (!r || state.loadingChapter || !r.chapters.length) return;
    await toggleBookmarkAt(r.chapterIndex);
  }

  // ---------- 事件绑定 ----------
  async function saveDownloadSettings() {
    const input = $('download-path');
    const error = $('download-error');
    error.classList.add('hidden');
    error.textContent = '';
    try {
      const saved = await post('saveDownloadSettings', {
        path: input.value,
        auto: $('auto-download').checked,
      });
      input.value = saved.path;
      $('auto-download').checked = !!saved.auto;
    } catch (e) {
      error.textContent = e.message || '下载设置没有保存';
      error.classList.remove('hidden');
    }
  }

  async function saveDataSettings() {
    els.dataError.classList.add('hidden');
    els.dataError.textContent = '';
    try {
      const saved = await post('saveDataSettings', { path: els.dataPath.value });
      els.dataPath.value = saved.path;
      els.dataHint.textContent = saved.path ? '' : '当前使用下载目录：' + (saved.effective || '');
      try {
        state.shelf = await post('getShelf', {});
      } catch (e) {
        state.shelf = [];
      }
      renderShelf();
      refreshSearch();
      updateReaderShelfBtn();
    } catch (e) {
      els.dataError.textContent = e.message || '数据路径没有保存';
      els.dataError.classList.remove('hidden');
    }
  }

  /** 手动读取当前数据目录下的 moyu-data.json 并刷新界面，便于跨设备交换数据。 */
  async function loadSharedData() {
    els.dataError.classList.add('hidden');
    els.dataError.textContent = '';
    els.dataImport.disabled = true;
    els.dataHint.textContent = '正在读取…';
    try {
      await post('importData', {});
      try {
        applyTheme(await post('getTheme', {}));
      } catch (e) {
        /* 保留当前主题 */
      }
      try {
        state.readerSettings = await post('getReaderSettings', {});
        els.fontSize.value = state.readerSettings.fontSize;
        els.fontModifier.value = state.readerSettings.fontSizeModifier;
        els.bookmarkModifier.value = state.readerSettings.bookmarkModifier;
        applyReaderFontSize();
      } catch (e) {
        /* 保留当前阅读设置 */
      }
      try {
        const download = await post('getDownloadSettings', {});
        $('download-path').value = download.path || '';
        $('auto-download').checked = !!download.auto;
      } catch (e) {
        /* 保留当前下载设置 */
      }
      try {
        state.shelf = await post('getShelf', {});
      } catch (e) {
        state.shelf = [];
      }
      renderShelf();
      refreshSearch();
      updateReaderShelfBtn();
      els.dataHint.textContent = '已读取，书架共 ' + state.shelf.length + ' 本书';
    } catch (e) {
      els.dataHint.textContent = '';
      els.dataError.textContent = e.message || '读取数据失败';
      els.dataError.classList.remove('hidden');
    } finally {
      els.dataImport.disabled = false;
    }
  }

  $('download-path').addEventListener('change', saveDownloadSettings);
  $('auto-download').addEventListener('change', saveDownloadSettings);
  $('data-path').addEventListener('change', saveDataSettings);
  $('data-import').addEventListener('click', loadSharedData);
  els.fontSize.addEventListener('input', () => {
    const value = Number(els.fontSize.value);
    if (Number.isFinite(value) && value >= 12 && value <= 32) els.fontPreview.style.fontSize = value + 'px';
  });
  els.fontSize.addEventListener('change', saveReaderSettings);
  els.fontModifier.addEventListener('change', saveReaderSettings);
  els.bookmarkModifier.addEventListener('change', saveReaderSettings);

  $('theme-switch').addEventListener('click', async (e) => {
    const btn = e.target.closest('.theme-btn');
    if (!btn) return;
    const theme = btn.dataset.theme;
    applyTheme(theme);
    try {
      applyTheme(await post('saveTheme', { theme }));
    } catch (err) {
      // 按钮已经先切过去，保存失败时保持当前外观
    }
  });

  $('search-btn').addEventListener('click', doSearch);
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  document.querySelector('.bottom-nav').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    state.detail = null;
    switchView(item.dataset.view);
    if (item.dataset.view === 'shelf') renderShelf();
  });

  document.addEventListener('click', async (e) => {
    if (!e.target.closest('.book-menu') && !e.target.closest('.dl-menu')) {
      document.querySelectorAll('.book-menu-pop, .dl-menu-pop').forEach((el) => el.classList.add('hidden'));
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.book-card, .dl-card, #detail-body');
    const id = (card && card.dataset.id) || (state.detail && state.detail.book && state.detail.book.id);
    const action = btn.dataset.action;

    if (action === 'menu' || action === 'dl-menu') {
      const pop = btn.parentElement.querySelector('.book-menu-pop, .dl-menu-pop');
      const willOpen = pop.classList.contains('hidden');
      document.querySelectorAll('.book-menu-pop, .dl-menu-pop').forEach((el) => el.classList.add('hidden'));
      if (willOpen) pop.classList.remove('hidden');
      return;
    }
    if (action === 'dl-retry') {
      if (id) await retryDownload(id);
      return;
    }
    if (action === 'dl-remove') {
      if (id) await removeDownload(id);
      return;
    }
    if (action === 'enter') {
      const book = findBook(id);
      if (book) await openDetail(book);
      return;
    }
    if (action === 'remove') {
      await removeFromShelf(id);
      if (state.detail && state.detail.book && state.detail.book.id === id) {
        state.detail = null;
        switchView('shelf');
      } else if (state.view === 'detail') {
        renderDetail();
      }
      return;
    }
    if (action === 'read') {
      const book = (state.detail && state.detail.book && state.detail.book.id === id && state.detail.book) || findBook(id);
      if (book) await openReader(book);
      return;
    }
    if (action === 'shelf') {
      const book = (state.detail && state.detail.book && state.detail.book.id === id && state.detail.book) || findBook(id);
      if (book) await addToShelf(book);
      if (state.view === 'detail') renderDetail();
      return;
    }
    if (action === 'download') {
      const book = (state.detail && state.detail.book && state.detail.book.id === id && state.detail.book) || findBook(id);
      if (book) await startBookDownload(book);
      return;
    }
    if (action === 'pause') {
      if (id) await pauseDownload(id);
      return;
    }
    if (action === 'bookmark-chapter') {
      const book = state.detail && state.detail.book;
      if (book) await openReader(book, Number(btn.dataset.index) || 0);
      return;
    }
    if (action === 'catalog-bookmark') {
      await toggleBookmarkAt(Number(btn.dataset.index));
      return;
    }
    if (action === 'detail-chapter') {
      const book = state.detail && state.detail.book;
      if (!book) return;
      await openReader(book, Number(btn.dataset.index) || 0);
      return;
    }
    if (action === 'detail-catalog') {
      const book = state.detail && state.detail.book;
      if (!book) return;
      await openReader(book, 0);
      state.catalogOpen = true;
      els.catalog.classList.remove('hidden');
    }
  });

  $('open-downloads').addEventListener('click', () => {
    void openDownloads();
  });
  $('downloads-back').addEventListener('click', () => {
    switchView('shelf');
    renderShelf();
  });
  $('detail-back').addEventListener('click', () => {
    const back = state.detailBack === 'search' ? 'search' : 'shelf';
    state.detail = null;
    switchView(back);
    if (back === 'shelf') renderShelf();
    else refreshSearch();
  });

  els.searchList.addEventListener('click', (e) => {
    const item = e.target.closest('.web-result');
    if (!item) return;
    const url = item.dataset.url;
    if (url) post('openLink', { url });
  });

  $('reader-back').addEventListener('click', closeReader);
  $('reader-bookmark').addEventListener('click', () => {
    void toggleCurrentBookmark();
  });
  $('reader-shelf').addEventListener('click', async () => {
    const book = state.reader && state.reader.book;
    if (!book) return;
    if (state.shelf.some((it) => it.book.id === book.id)) return;
    await addToShelf(book);
  });
  $('prev-chapter').addEventListener('click', () => {
    if (state.reader && !state.loadingChapter) loadChapter(state.reader.chapterIndex - 1);
  });
  $('next-chapter').addEventListener('click', () => {
    if (state.reader && !state.loadingChapter) loadChapter(state.reader.chapterIndex + 1);
  });

  $('reader-catalog').addEventListener('click', () => {
    state.catalogOpen = !state.catalogOpen;
    els.catalog.classList.toggle('hidden', !state.catalogOpen);
  });
  $('catalog-close').addEventListener('click', () => {
    state.catalogOpen = false;
    els.catalog.classList.add('hidden');
  });

  els.readerBody.addEventListener('wheel', (e) => {
    if (!state.reader || !modifierPressed(e, state.readerSettings.fontSizeModifier)) return;
    e.preventDefault();
    const next = Math.min(32, Math.max(12, state.readerSettings.fontSize + (e.deltaY < 0 ? 1 : -1)));
    if (next === state.readerSettings.fontSize) return;
    state.readerSettings.fontSize = next;
    applyReaderFontSize();
    void saveReaderSettings();
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (!state.reader || e.key.toLowerCase() !== 's' || !modifierPressed(e, state.readerSettings.bookmarkModifier)) return;
    e.preventDefault();
    void toggleCurrentBookmark();
  });
  els.catalogList.addEventListener('click', (e) => {
    const bookmark = e.target.closest('.catalog-bookmark');
    if (bookmark) return;
    const item = e.target.closest('.catalog-item');
    if (item) {
      loadChapter(Number(item.dataset.index));
      state.catalogOpen = false;
      els.catalog.classList.add('hidden');
    }
  });

  const THEME_SUB = {
    auto: '界面跟随编辑器主题',
    light: '界面固定为浅色',
    dark: '界面固定为深色',
  };

  function applyTheme(theme) {
    const next = theme === 'light' || theme === 'dark' ? theme : 'auto';
    state.theme = next;
    document.body.classList.toggle('theme-light', next === 'light');
    document.body.classList.toggle('theme-dark', next === 'dark');
    document.querySelectorAll('.theme-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === next);
    });
    const sub = $('theme-sub');
    if (sub) sub.textContent = THEME_SUB[next];
  }

  // ---------- 初始化 ----------
  (async function init() {
    switchView('search');
    try {
      applyTheme(await post('getTheme', {}));
    } catch (e) {
      applyTheme('auto');
    }
    try {
      state.readerSettings = await post('getReaderSettings', {});
      els.fontModifier.value = state.readerSettings.fontSizeModifier;
      els.bookmarkModifier.value = state.readerSettings.bookmarkModifier;
      applyReaderFontSize();
    } catch (e) {
      applyReaderFontSize();
    }
    try {
      const download = await post('getDownloadSettings', {});
      $('download-path').value = download.path || '';
      $('auto-download').checked = !!download.auto;
    } catch (e) {
      $('download-error').textContent = e.message || '没有读到下载设置';
      $('download-error').classList.remove('hidden');
    }
    try {
      const data = await post('getDataSettings', {});
      els.dataPath.value = data.path || '';
      els.dataHint.textContent = data.path ? '' : '当前使用下载目录：' + (data.effective || '');
    } catch (e) {
      els.dataError.textContent = e.message || '没有读到数据路径';
      els.dataError.classList.remove('hidden');
    }
    try {
      state.shelf = await post('getShelf', {});
    } catch (e) {
      state.shelf = [];
    }
    try {
      const tasks = await post('listDownloads', {});
      if (Array.isArray(tasks)) state.downloads = tasks;
    } catch (e) {
      state.downloads = [];
    }
    renderShelf();
    els.searchList.innerHTML =
      '<div class="hint">输入书名。搜索后会打开网页，识别出的小说可以阅读并加入书架</div>';
  })();
})();