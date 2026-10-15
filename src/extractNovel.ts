import { Book, Chapter } from './types';

/** 页面里抽出来的结构。由浏览器里的 extractNovelPage 产生，再交给下面的纯函数判断。 */
export interface ExtractedLink {
  title: string;
  href: string;
}

export interface ExtractedPage {
  finalUrl: string;
  pageTitle: string;
  h1: string;
  bookNameMeta: string;
  author: string;
  description: string;
  category: string;
  updateTime: string;
  latestChapter: string;
  coverUrl: string;
  breadcrumbs: string[];
  chapterLinks: ExtractedLink[];
  /** 目录被拆成多页时，每一页的地址 */
  listPages: string[];
  /** 下拉页码里能看出的章节总数；没有分页时等于当前页章节数 */
  chapterTotal: number;
  catalogUrl: string;
  hasPrevNext: boolean;
  hasNovelMeta: boolean;
  contentTitle: string;
  contentText: string;
  contentChars: number;
}

const CHAPTER_RE = /第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章节回卷集部]/;
const EXTRA_RE = /^(序章|楔子|前言|引子|序言|番外|终章|尾声|后记|完本感言|大结局)/;

export function isChapterTitle(title: string): boolean {
  const s = title.replace(/\s+/g, ' ').trim();
  if (!s || s.length > 80) {
    return false;
  }
  return CHAPTER_RE.test(s) || EXTRA_RE.test(s);
}

function chineseCount(s: string): number {
  const m = s.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function toAsciiDigits(s: string): string {
  return s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
}

function parseCn(raw: string): number | null {
  const s = toAsciiDigits(raw);
  if (/^\d+$/.test(s)) {
    return Number(s);
  }
  const digit: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const unit: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0;
  let current = 0;
  let saw = false;
  for (const ch of s) {
    if (Object.prototype.hasOwnProperty.call(digit, ch)) {
      current = digit[ch];
      saw = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(unit, ch)) {
      const u = unit[ch];
      saw = true;
      if (u === 10000) {
        total = (total + current) * u;
        current = 0;
      } else {
        total += (current || 1) * u;
        current = 0;
      }
      continue;
    }
    return null;
  }
  if (!saw) {
    return null;
  }
  const n = total + current;
  if (!Number.isFinite(n) || n <= 0 || n > 100000) {
    return null;
  }
  return n;
}

export function chapterNo(title: string): number | null {
  const m = title.match(/第\s*([0-9０-９零〇一二三四五六七八九十百千万两]+)\s*[章节回卷集部]/);
  if (!m) {
    return null;
  }
  return parseCn(m[1]);
}

function sortKey(title: string): number | null {
  const t = title.trim();
  if (/^(序章|楔子|前言|引子|序言)/.test(t)) {
    return -1;
  }
  if (/^(后记|完本感言|尾声|大结局)/.test(t)) {
    return 1000000;
  }
  if (/^番外/.test(t)) {
    const n = chapterNo(t);
    return n == null ? 900000 : n;
  }
  return chapterNo(t);
}

/** 章节号能对上时按章节号排，序章在前、后记在后；对不上就保持网页原来的顺序。 */
export function orderChapters(chapters: Chapter[]): Chapter[] {
  const keyed = chapters.map((c, i) => ({ c, n: sortKey(c.title), i }));
  const known = keyed.filter((x) => x.n != null).length;
  if (known < 4 || known / chapters.length < 0.6) {
    return chapters;
  }
  return keyed
    .sort((a, b) => {
      if (a.n == null && b.n == null) {
        return a.i - b.i;
      }
      if (a.n == null) {
        return 1;
      }
      if (b.n == null) {
        return -1;
      }
      if (a.n !== b.n) {
        return a.n - b.n;
      }
      return a.i - b.i;
    })
    .map((x) => x.c);
}

function hostKey(host: string): string {
  return host.replace(/^www\./i, '').toLowerCase();
}

/** 同一本书的章节链接通常落在同一个目录下，用来排除首页那种混在一起的更新列表。 */
export function linksLookLikeOneBook(links: { href: string }[]): boolean {
  if (links.length < 5) {
    return false;
  }
  const segs: string[][] = [];
  const parents: string[] = [];
  for (const link of links.slice(0, 50)) {
    try {
      const u = new URL(link.href);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length) {
        parts.pop();
      }
      segs.push([hostKey(u.host), ...parts]);
      parents.push(hostKey(u.host) + '/' + parts.join('/'));
    } catch {
      // 跳过无法解析的链接
    }
  }
  if (segs.length < 5) {
    return false;
  }
  let prefix = segs[0].slice();
  for (const s of segs) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) {
      i++;
    }
    prefix = prefix.slice(0, i);
  }
  if (prefix.length >= 2) {
    return true;
  }
  const counts = new Map<string, number>();
  for (const p of parents) {
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  let max = 0;
  for (const n of counts.values()) {
    if (n > max) {
      max = n;
    }
  }
  return max / parents.length >= 0.65;
}

function isPortal(p: ExtractedPage): boolean {
  if (p.hasNovelMeta || isChapterTitle(p.h1)) {
    return false;
  }
  return /首页|排行榜|小说排行|热门推荐|书库/.test(`${p.pageTitle} ${p.h1}`);
}

export function classifyExtract(p: ExtractedPage): 'catalog' | 'chapter' | null {
  const portal = isPortal(p);
  const oneBook = linksLookLikeOneBook(p.chapterLinks);
  if (!portal && p.chapterLinks.length >= 8 && oneBook) {
    return 'catalog';
  }
  if (!portal && p.hasNovelMeta && p.chapterLinks.length >= 5 && oneBook) {
    return 'catalog';
  }
  const chapterish = isChapterTitle(p.h1) || isChapterTitle(p.contentTitle);
  if (chapterish && p.contentChars >= 80 && (p.hasPrevNext || !!p.catalogUrl || p.hasNovelMeta)) {
    return 'chapter';
  }
  if (chapterish && p.contentChars >= 200 && p.chapterLinks.length >= 3) {
    return 'chapter';
  }
  return null;
}

function looksLikeSiteName(s: string): boolean {
  return /(小说网|阅读网|文学网|书库|书屋|手机站|电脑站|最新章节|全文阅读|免费阅读|在线阅读)$/.test(s);
}

function cleanName(s: string): string {
  return s.replace(/\s*(最新章节|全文阅读|免费阅读|在线阅读).*$/, '').trim();
}

export function guessBookTitle(p: ExtractedPage): string {
  if (p.bookNameMeta) {
    const meta = cleanName(p.bookNameMeta);
    if (meta && meta.length <= 40 && !isChapterTitle(meta)) {
      return meta;
    }
  }
  for (const crumb of p.breadcrumbs) {
    const c = cleanName(crumb);
    if (c && c !== '首页' && c.length <= 40 && !isChapterTitle(c) && !looksLikeSiteName(c)) {
      return c;
    }
  }
  const h1 = cleanName(p.h1);
  if (h1 && !isChapterTitle(h1) && h1.length <= 40 && !/首页|排行/.test(h1) && !looksLikeSiteName(h1)) {
    return h1;
  }
  const parts = p.pageTitle
    .split(/\s*[_\-|｜—·]\s*/)
    .map((s) => cleanName(s))
    .filter(Boolean);
  const named = parts.filter((s) => !isChapterTitle(s) && s.length >= 2 && s.length <= 30 && !looksLikeSiteName(s));
  if (named.length) {
    return named[0];
  }
  return cleanName(parts[0] || p.h1 || '未命名小说');
}

export function cleanAuthor(s: string): string {
  const t = s.replace(/^作者[：:\s]*/, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 20 || /小说网|阅读网|书屋|书库/.test(t)) {
    return '';
  }
  return t;
}

export function clipText(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) {
    return t;
  }
  return t.slice(0, max).trim() + '…';
}

const LINE_NOISE =
  /上一章|下一章|返回目录|章节目录|加入书签|加入收藏|收藏本站|手机阅读|手机用户|请记住|最新网址|最新域名|首发域名|推荐阅读|相关推荐|猜你喜欢|热门推荐|点击阅读|继续阅读|加载中|广告合作|版权所有|备案号|All Rights Reserved/i;

/** 去掉导航、广告、网址提示，只留下可以阅读的正文段落。 */
export function cleanNovelText(raw: string): string {
  const lines = raw
    .split(/\n+/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean);
  const kept = lines.filter((line) => {
    if (LINE_NOISE.test(line) && line.length < 80) {
      return false;
    }
    if (/^https?:\/\//i.test(line) && line.length < 80) {
      return false;
    }
    if (chineseCount(line) === 0 && line.length < 40) {
      return false;
    }
    return true;
  });
  return kept.join('\n\n').trim();
}

export function stripLeadingTitle(text: string, title: string): string {
  const parts = text.split(/\n{2,}/);
  if (!parts.length || !title) {
    return text.trim();
  }
  const first = parts[0].replace(/\s+/g, '');
  const t = title.replace(/\s+/g, '');
  if (t && (first === t || (first.endsWith(t) && first.length < t.length + 8))) {
    parts.shift();
  }
  return parts.join('\n\n').trim();
}

export function webBookId(url: string): string {
  let key = url.trim().toLowerCase();
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    key = (hostKey(u.host) + path + u.search).toLowerCase();
  } catch {
    // 使用原始字符串
  }
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'web:' + (h >>> 0).toString(16);
}

export function chaptersFromLinks(links: ExtractedLink[], extra?: Chapter): Chapter[] {
  const seen = new Set<string>();
  const out: Chapter[] = [];
  const all = extra ? [...links.map((l) => ({ title: l.title, href: l.href })), { title: extra.title, href: extra.url || extra.id }] : links.map((l) => ({ title: l.title, href: l.href }));
  for (const link of all) {
    if (!isChapterTitle(link.title) && !(extra && link.href === extra.url)) {
      continue;
    }
    let url = link.href;
    try {
      const u = new URL(link.href);
      u.hash = '';
      url = u.href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    out.push({
      id: url,
      title: link.title.replace(/\s+/g, ' ').trim(),
      url,
    });
  }
  return orderChapters(out);
}

export function bookFromExtract(meta: ExtractedPage, pageUrl: string, catalogUrl: string, chapters: Chapter[]): Book {
  const author = cleanAuthor(meta.author) || '未知';
  let description = meta.description;
  if ((!description || description.length < 8) && meta.chapterLinks.length >= 5 && meta.contentChars >= 40 && meta.contentChars < 900) {
    description = meta.contentText;
  }
  const latestChapter =
    (meta.latestChapter || '').trim() || (chapters.length ? chapters[chapters.length - 1].title : '');
  return {
    id: webBookId(catalogUrl || pageUrl),
    title: guessBookTitle(meta) || '未命名小说',
    author,
    description: clipText(description || '已识别为小说，阅读时只保留正文。', 160),
    category: meta.category || '网络小说',
    wordCount: chapters.length ? `${chapters.length} 章` : '',
    updateTime: (meta.updateTime || '').trim(),
    latestChapter,
    coverUrl: (meta.coverUrl || '').trim(),
    source: 'web',
    pageUrl,
    catalogUrl: catalogUrl || pageUrl,
  };
}

/**
 * 在网页里执行：找出最像目录的链接块，以及去掉导航/广告后的正文。
 * 这个函数会被原样送到浏览器，不能引用外面的变量。
 */
export function extractNovelPage(): ExtractedPage {
  function textOf(el: Element | null): string {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function classId(el: Element): string {
    const id = (el as HTMLElement).id || '';
    const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '';
    return id + ' ' + cls;
  }

  function hostOf(hostname: string): string {
    return hostname.replace(/^www\./i, '').toLowerCase();
  }

  function chineseLen(s: string): number {
    const m = s.match(/[\u4e00-\u9fff]/g);
    return m ? m.length : 0;
  }

  const chapterRe = /第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章节回卷集部]/;
  const extraRe = /^(序章|楔子|前言|引子|序言|番外|终章|尾声|后记|完本感言|大结局)/;

  function chapterTitle(title: string): boolean {
    const s = title.replace(/\s+/g, ' ').trim();
    if (!s || s.length > 80) {
      return false;
    }
    return chapterRe.test(s) || extraRe.test(s);
  }

  function labelOf(el: Element): string {
    return textOf(el) || (el.getAttribute('title') || '').trim() || (el.getAttribute('aria-label') || '').trim();
  }

  function metaContent(selector: string): string {
    const el = document.querySelector(selector);
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  let bookNameMeta =
    metaContent('meta[property="og:novel:book_name"]') ||
    metaContent('meta[property="og:book:name"]');
  let author =
    metaContent('meta[property="og:novel:author"]') ||
    metaContent('meta[name="author"]');
  let description =
    metaContent('meta[property="og:description"]') ||
    metaContent('meta[name="description"]');
  let category = metaContent('meta[property="og:novel:category"]');
  let updateTime =
    metaContent('meta[property="og:novel:update_time"]') ||
    metaContent('meta[property="book:release_date"]');
  let latestChapter =
    metaContent('meta[property="og:novel:latest_chapter_name"]') ||
    metaContent('meta[property="og:novel:chapter_name"]');
  let coverUrl =
    metaContent('meta[property="og:image"]') ||
    metaContent('meta[property="og:novel:cover"]') ||
    metaContent('meta[name="og:image"]');
  let hasNovelMeta = !!bookNameMeta;

  document.querySelectorAll('script[type="application/ld+json"]').forEach((node) => {
    try {
      const parsed = JSON.parse(node.textContent || 'null');
      const stack = Array.isArray(parsed) ? parsed.slice() : [parsed];
      while (stack.length) {
        const item = stack.pop();
        if (!item || typeof item !== 'object') {
          continue;
        }
        if (Array.isArray(item['@graph'])) {
          item['@graph'].forEach((x: unknown) => stack.push(x));
        }
        const typ = item['@type'];
        const types = Array.isArray(typ) ? typ : typ ? [typ] : [];
        const isBook = types.some((t: unknown) => /^(book|novel)$/i.test(String(t)));
        if (!isBook) {
          continue;
        }
        hasNovelMeta = true;
        if (!bookNameMeta && item.name) {
          bookNameMeta = String(item.name);
        }
        if (!author && item.author) {
          author = typeof item.author === 'string' ? item.author : (item.author.name || '');
        }
        if (!description && item.description) {
          description = String(item.description);
        }
      }
    } catch {
      // 忽略无法解析的结构化数据
    }
  });

  const h1 = textOf(document.querySelector('h1'));
  const pageHost = hostOf(location.host);

  const chapterAnchors: { title: string; href: string; el: HTMLAnchorElement }[] = [];
  document.querySelectorAll('a').forEach((a) => {
    const title = labelOf(a);
    if (!chapterTitle(title)) {
      return;
    }
    const href = a.href;
    if (!/^https?:\/\//i.test(href)) {
      return;
    }
    try {
      if (hostOf(new URL(href).host) !== pageHost) {
        return;
      }
    } catch {
      return;
    }
    chapterAnchors.push({ title, href, el: a });
  });

  const groups = new Map<Element, { title: string; href: string }[]>();
  chapterAnchors.forEach((item) => {
    let el: Element | null = item.el.parentElement;
    let depth = 0;
    while (el && el !== document.body && depth < 16) {
      const list = groups.get(el) || [];
      list.push({ title: item.title, href: item.href });
      groups.set(el, list);
      el = el.parentElement;
      depth++;
    }
  });

  let max = 0;
  groups.forEach((list) => {
    if (list.length > max) {
      max = list.length;
    }
  });
  let bestEl: Element | null = null;
  let bestDepth = -1;
  groups.forEach((list, el) => {
    if (list.length !== max || max === 0) {
      return;
    }
    let depth = 0;
    let p: Element | null = el;
    while (p && p !== document.body) {
      depth++;
      p = p.parentElement;
    }
    if (depth > bestDepth) {
      bestDepth = depth;
      bestEl = el;
    }
  });

  const chapterLinks: { title: string; href: string }[] = [];
  const seenHref = new Set<string>();
  const chosen = bestEl ? groups.get(bestEl) || [] : [];
  chosen.forEach((item) => {
    if (seenHref.has(item.href) || chapterLinks.length >= 3000) {
      return;
    }
    seenHref.add(item.href);
    chapterLinks.push({ title: item.title.replace(/\s+/g, ' ').trim(), href: item.href });
  });

  function absLink(href: string): string {
    try {
      if (!href || /^javascript:/i.test(href)) {
        return '';
      }
      const u = new URL(href, location.href);
      if (hostOf(u.host) !== pageHost) {
        return '';
      }
      if (!/^https?:/i.test(u.href)) {
        return '';
      }
      u.hash = '';
      return u.href;
    } catch {
      return '';
    }
  }

  const listPages: string[] = [];
  const seenList = new Set<string>();
  function addListPage(href: string) {
    const abs = absLink(href);
    if (!abs || seenList.has(abs) || listPages.length >= 120) {
      return;
    }
    seenList.add(abs);
    listPages.push(abs);
  }

  function ascPage(num: string): string {
    try {
      const u = new URL(location.href);
      if (!/\/asc-\d+\/?$/i.test(u.pathname)) {
        return '';
      }
      u.pathname = u.pathname.replace(/asc-\d+\/?$/i, 'asc-' + num + '/');
      u.hash = '';
      return u.href;
    } catch {
      return '';
    }
  }

  function unwrapNestedAsc(href: string): string {
    try {
      const u = new URL(href);
      const nested = u.pathname.match(/\/asc-\d+\/asc-(\d+)\/?$/i);
      if (!nested) {
        return href;
      }
      u.pathname = u.pathname.replace(/\/asc-\d+\/asc-\d+\/?$/i, '/asc-' + nested[1] + '/');
      u.hash = '';
      return u.href;
    } catch {
      return href;
    }
  }

  let chapterTotal = chapterLinks.length;
  let rangeCount = 0;
  const rangeRe = /第?\s*([0-9０-９]+)\s*[-~～—到至]\s*([0-9０-９]+)\s*章/;
  document.querySelectorAll('select option').forEach((opt) => {
    const text = (opt.textContent || '').replace(/\s+/g, ' ').trim();
    const value = ((opt as HTMLOptionElement).value || '').trim();
    const range = text.match(rangeRe);
    if (range) {
      rangeCount += 1;
      const endText = range[2].replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30));
      const end = parseInt(endText, 10);
      if (end > chapterTotal) {
        chapterTotal = end;
      }
      const ascName = value.match(/^asc-(\d+)\/?$/i);
      if (ascName) {
        addListPage(ascPage(ascName[1]));
        return;
      }
      if (!/^\d+$/.test(value)) {
        addListPage(unwrapNestedAsc(absLink(value)));
      }
      return;
    }
    if (!chapterTitle(text)) {
      return;
    }
    const href = absLink(value);
    if (!href || seenHref.has(href) || chapterLinks.length >= 3000) {
      return;
    }
    seenHref.add(href);
    chapterLinks.push({ title: text, href });
  });

  if (rangeCount >= 2) {
    const pages = Math.min(rangeCount, 120);
    const path = location.pathname;
    if (/\/asc-\d+\/?$/i.test(path)) {
      for (let i = 1; i <= pages; i++) {
        addListPage(ascPage(String(i)));
      }
    } else {
      const tail = path.match(/\/(\d+)\/?$/);
      if (tail && Number(tail[1]) >= 1 && Number(tail[1]) <= pages) {
        for (let i = 1; i <= pages; i++) {
          try {
            const u = new URL(location.href);
            u.pathname = path.replace(/\/\d+\/?$/, '/' + i + '/');
            u.hash = '';
            addListPage(u.href);
          } catch {
            break;
          }
        }
      }
    }
  }

  if (chapterLinks.length >= 8) {
    addListPage(location.href);
    document.querySelectorAll('a').forEach((a) => {
      const label = labelOf(a).replace(/\s+/g, '');
      if (/^(上一页|下一页|上页|下页)$/.test(label)) {
        addListPage(a.href);
      }
      if (/^\d{1,3}$/.test(label)) {
        const href = a.getAttribute('href') || '';
        if (/asc-|index[_-]?\d|list[_-]?\d|page=\d|\/\d+\/?$/i.test(href)) {
          addListPage(a.href);
        }
      }
    });
  }

  let catalogUrl = '';
  let hasPrevNext = false;
  document.querySelectorAll('a, button').forEach((el) => {
    const label = labelOf(el).replace(/\s+/g, '');
    if (/上一章|下一章/.test(label)) {
      hasPrevNext = true;
    }
    if (catalogUrl || !/^(目录|章节目录|全部章节|查看目录|返回目录)$/.test(label)) {
      return;
    }
    const href = (el as HTMLAnchorElement).href || '';
    if (!/^https?:\/\//i.test(href)) {
      return;
    }
    try {
      const u = new URL(href);
      if (hostOf(u.host) !== pageHost) {
        return;
      }
      if (u.href.split('#')[0] === location.href.split('#')[0] && u.hash) {
        return;
      }
      catalogUrl = u.href.split('#')[0];
    } catch {
      // 忽略坏链接
    }
  });

  const breadcrumbs: string[] = [];
  document.querySelectorAll('[class*="breadcrumb"] a, [class*="crumb"] a, [class*="location"] a').forEach((a) => {
    const t = textOf(a);
    if (t && breadcrumbs.length < 8) {
      breadcrumbs.push(t);
    }
  });

  if (!author) {
    const head = (document.body ? document.body.innerText : '').slice(0, 1800);
    const m = head.match(/作\s*者\s*[：:\s]\s*([^\s,，。|｜_\-]{1,20})/);
    if (m) {
      author = m[1];
    }
  }
  if (!category) {
    const head = (document.body ? document.body.innerText : '').slice(0, 1800);
    const m = head.match(/(?:类\s*型|分\s*类)\s*[：:\s]\s*([^\s,，。|｜_\-]{1,20})/);
    if (m) {
      category = m[1];
    }
  }
  if (!updateTime) {
    const head = (document.body ? document.body.innerText : '').slice(0, 2200);
    const m = head.match(/(?:更新时间|最后更新|最近更新)\s*[：:\s]\s*([0-9年月日\-/:：\s]{6,24})/);
    if (m) {
      updateTime = m[1].replace(/\s+/g, ' ').trim();
    }
  }
  if (!latestChapter) {
    const head = (document.body ? document.body.innerText : '').slice(0, 2200);
    const m = head.match(/(?:最新章节|最近章节)\s*[：:\s]\s*([^\n]{2,60})/);
    if (m) {
      latestChapter = m[1].replace(/\s+/g, ' ').trim();
    }
  }
  if (!coverUrl) {
    const coverImg = document.querySelector(
      'img[class*="cover" i], img[id*="cover" i], .bookimg img, .book-cover img, .cover img, #fmimg img'
    ) as HTMLImageElement | null;
    const src = coverImg ? coverImg.currentSrc || coverImg.src || coverImg.getAttribute('data-src') || '' : '';
    if (/^https?:\/\//i.test(src)) {
      coverUrl = src.split('#')[0];
    }
  }
  if (coverUrl && !/^https?:\/\//i.test(coverUrl)) {
    try {
      coverUrl = new URL(coverUrl, location.href).href;
    } catch {
      coverUrl = '';
    }
  }
  if (!latestChapter && chapterLinks.length) {
    latestChapter = chapterLinks[chapterLinks.length - 1].title;
  }

  const noiseRe =
    /(?:^|[\s_-])(?:nav|menu|header|footer|comment|sidebar|aside|recommend|related|copyright|breadcrumb|share|login|banner|ads?|chapter-?list|catalog)(?:$|[\s_-])/i;

  function readableText(root: Element, stripNoise: boolean): string {
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script,style,noscript,iframe,svg,canvas,form,button,input,textarea,ins').forEach((n) => n.remove());
    if (stripNoise) {
      Array.from(clone.querySelectorAll('*')).forEach((n) => {
        if (noiseRe.test(classId(n))) {
          n.remove();
        }
      });
    }
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    clone.querySelectorAll('p,h1,h2,h3,h4,li,tr').forEach((n) => {
      n.appendChild(document.createTextNode('\n'));
    });
    clone.querySelectorAll('div').forEach((n) => {
      if (!n.querySelector('div,p')) {
        n.appendChild(document.createTextNode('\n'));
      }
    });
    return (clone.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function consider(el: Element, stripNoise: boolean, best: { text: string; score: number }): { text: string; score: number } {
    if (el === document.body || el === document.documentElement) {
      return best;
    }
    const text = readableText(el, stripNoise);
    const chars = chineseLen(text);
    if (chars < 80) {
      return best;
    }
    const linkText = Array.from(el.querySelectorAll('a')).map((a) => textOf(a)).join('');
    const density = chineseLen(linkText) / Math.max(chars, 1);
    if (density > 0.4) {
      return best;
    }
    let score = chars * (1 - density);
    if (stripNoise && noiseRe.test(classId(el))) {
      score *= 0.2;
    }
    if (el.querySelectorAll('p,br').length >= 4) {
      score *= 1.1;
    }
    if (score > best.score) {
      return { text: text.slice(0, 80000), score };
    }
    return best;
  }

  const known = [
    '#chaptercontent', '#chapterContent', '#BookText', '#booktxt', '#htmlContent',
    '#content', '#nr1', '#nr', '#txt', 'article', 'main',
    '.chapter-content', '.read-content', '.novelcontent', '.content',
  ];
  const candidateSet = new Set<Element>();
  known.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => candidateSet.add(el));
  });
  const blocks = document.querySelectorAll('div, section, article');
  if (blocks.length <= 2500) {
    blocks.forEach((el) => {
      if (el.querySelectorAll('br').length >= 6 || el.querySelectorAll('p').length >= 4) {
        candidateSet.add(el);
      }
    });
  }

  let best = { text: '', score: 0 };
  candidateSet.forEach((el) => {
    best = consider(el, true, best);
  });
  if (chineseLen(best.text) < 80) {
    candidateSet.forEach((el) => {
      best = consider(el, false, best);
    });
  }

  let contentTitle = textOf(document.querySelector('h1, .chapter-title, .chapterTitle, #chapterTitle'));
  if (!contentTitle) {
    const first = best.text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    if (chapterTitle(first)) {
      contentTitle = first;
    }
  }

  return {
    finalUrl: location.href.split('#')[0],
    pageTitle: (document.title || '').trim(),
    h1,
    bookNameMeta,
    author: (author || '').trim(),
    description: (description || '').trim(),
    category: (category || '').trim(),
    updateTime: (updateTime || '').trim(),
    latestChapter: (latestChapter || '').trim(),
    coverUrl: (coverUrl || '').trim(),
    breadcrumbs,
    chapterLinks,
    listPages,
    chapterTotal,
    catalogUrl,
    hasPrevNext,
    hasNovelMeta,
    contentTitle,
    contentText: best.text,
    contentChars: chineseLen(best.text),
  };
}
