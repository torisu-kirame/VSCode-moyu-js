import * as fs from 'fs';
import { Browser, BrowserContext, chromium, Page } from 'playwright-core';
import {
  bookFromExtract,
  chaptersFromLinks,
  classifyExtract,
  cleanNovelText,
  ExtractedLink,
  ExtractedPage,
  extractNovelPage,
  isChapterTitle,
  linksLookLikeOneBook,
  stripLeadingTitle,
} from './extractNovel';
import { Book, Chapter, ChapterContent } from './types';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  host: string;
}

export interface InspectedResult extends WebResult {
  isBook: boolean;
  book?: Book;
}

interface AnalyzedBook {
  book: Book;
  chapters: Chapter[];
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  (process.env.LOCALAPPDATA || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
];

const chapterMemory = new Map<string, { chapters: Chapter[]; complete: boolean }>();
const MAX_LIST_PAGES = 100;

function findEdge(): string {
  for (const p of EDGE_CANDIDATES) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  throw new Error('未找到 Microsoft Edge 浏览器，无法联网搜索。');
}

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        executablePath: findEdge(),
        headless: true,
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((e) => {
        browserPromise = null;
        throw new Error('启动 Edge 失败：' + (e instanceof Error ? e.message : String(e)));
      });
  }
  return browserPromise;
}

async function openContext(blockAssets = true): Promise<BrowserContext> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'zh-CN',
    userAgent: UA,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  });
  if (blockAssets) {
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        void route.abort();
      } else {
        void route.continue();
      }
    });
  }
  return context;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function sameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).host.replace(/^www\./i, '');
    const hb = new URL(b).host.replace(/^www\./i, '');
    return ha.toLowerCase() === hb.toLowerCase();
  } catch {
    return false;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const n = Math.min(Math.max(limit, 1), Math.max(items.length, 1));
  await Promise.all(
    Array.from({ length: items.length === 0 ? 0 : n }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await worker(items[index], index);
      }
    })
  );
  return out;
}

async function readExtracted(page: Page, url: string, timeout = 12000): Promise<ExtractedPage | null> {
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page
      .waitForFunction(
        () => {
          const text = (document.body && document.body.innerText) || '';
          return text.replace(/\s/g, '').length > 40 || document.querySelectorAll('a').length > 15;
        },
        { timeout: 4000 }
      )
      .catch(() => {});
    return await page.evaluate(extractNovelPage);
  } catch {
    return null;
  }
}

function remember(bookId: string, chapters: Chapter[], complete: boolean) {
  if (!bookId || !chapters.length) {
    return;
  }
  const prev = chapterMemory.get(bookId);
  if (prev && prev.complete && prev.chapters.length >= chapters.length) {
    return;
  }
  chapterMemory.set(bookId, { chapters, complete });
}

export function recallChapters(bookId: string): Chapter[] | undefined {
  const hit = chapterMemory.get(bookId);
  if (!hit || !hit.complete || !hit.chapters.length) {
    return undefined;
  }
  return hit.chapters;
}

function normListUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return (u.origin + path + u.search).toLowerCase();
  } catch {
    return url;
  }
}

/** 有些站第 1 页不在下拉框里，但 asc-1 和后面的分页是同一套地址。 */
function fillMissingAscPages(urls: string[]): string[] {
  const groups = new Map<string, { origin: string; prefix: string; suffix: string; nums: Set<number> }>();
  for (const url of urls) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/^(.*\/asc-)(\d+)(\/?)$/i);
      if (!m) {
        continue;
      }
      const key = u.origin + m[1].toLowerCase();
      let group = groups.get(key);
      if (!group) {
        group = { origin: u.origin, prefix: m[1], suffix: m[3] || '/', nums: new Set<number>() };
        groups.set(key, group);
      }
      group.nums.add(Number(m[2]));
    } catch {
      // 跳过无法解析的地址
    }
  }
  const extra: string[] = [];
  groups.forEach((group) => {
    let max = 0;
    group.nums.forEach((n) => {
      if (n > max) {
        max = n;
      }
    });
    if (max >= 1 && max <= MAX_LIST_PAGES && group.nums.size < max) {
      for (let i = 1; i <= max; i++) {
        if (!group.nums.has(i)) {
          extra.push(group.origin + group.prefix + i + group.suffix);
        }
      }
    }
  });
  return extra.concat(urls);
}

/** 第 1 页有时会另给一个 /book/编号/ 地址，打开它容易卡住。已经有 asc-1 时就用 asc-1。 */
function dropRedundantBookLanding(urls: string[]): string[] {
  const hasAsc1 = urls.some((url) => {
    try {
      return /\/asc-1\/?$/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  });
  if (!hasAsc1) {
    return urls;
  }
  return urls.filter((url) => {
    try {
      return !/\/book\/\d+\/?$/i.test(new URL(url).pathname);
    } catch {
      return true;
    }
  });
}

function looksBlocked(page: ExtractedPage | null): boolean {
  if (!page) {
    return true;
  }
  return /just a moment|请稍候|cloudflare|access denied/i.test(page.pageTitle);
}

async function readListPage(page: Page, url: string): Promise<ExtractedPage | null> {
  let data = await readExtracted(page, url, 8000);
  if (!data || data.chapterLinks.length === 0 || looksBlocked(data)) {
    await page.waitForTimeout(900);
    data = await readExtracted(page, url, 8000);
  }
  if (!data || looksBlocked(data) || data.chapterLinks.length === 0) {
    return null;
  }
  return data;
}

async function newListPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(12000);
  return page;
}

async function crawlChapterLists(seeds: string[]): Promise<ExtractedLink[]> {
  const pending = dropRedundantBookLanding(fillMissingAscPages(seeds)).slice(0, MAX_LIST_PAGES);
  const seen = new Set<string>();
  const failed: string[] = [];
  const links: ExtractedLink[] = [];
  let context = await openContext(false);
  let page = await newListPage(context);

  // 有些站对连续翻页限速，返回验证页；换一个全新会话通常就能继续读。
  const rotate = async () => {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1200));
    context = await openContext(false);
    page = await newListPage(context);
  };

  const visit = async (url: string, rememberFailure: boolean) => {
    const key = normListUrl(url);
    if (!url || seen.has(key) || seen.size >= MAX_LIST_PAGES) {
      return;
    }
    seen.add(key);
    let data = await readListPage(page, url);
    if (!data) {
      await rotate();
      data = await readListPage(page, url);
    }
    if (!data) {
      if (rememberFailure) {
        failed.push(url);
      }
      return;
    }
    links.push(...data.chapterLinks);
    for (const next of data.listPages || []) {
      if (pending.length >= MAX_LIST_PAGES) {
        break;
      }
      if (!seen.has(normListUrl(next))) {
        pending.push(next);
      }
    }
    await page.waitForTimeout(280);
  };

  try {
    for (let i = 0; i < pending.length && seen.size < MAX_LIST_PAGES; i++) {
      await visit(pending[i], true);
    }
    for (const url of failed) {
      seen.delete(normListUrl(url));
    }
    for (const url of failed) {
      if (seen.size >= MAX_LIST_PAGES) {
        break;
      }
      await visit(url, false);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
  return links;
}

async function analyzeUrl(page: Page, url: string): Promise<AnalyzedBook | null> {
  const first = await readExtracted(page, url);
  if (!first) {
    return null;
  }

  const firstKind = classifyExtract(first);
  let catalog: ExtractedPage | null = null;
  const catalogHref = first.catalogUrl;
  const shouldOpenCatalog =
    !!catalogHref &&
    catalogHref !== first.finalUrl &&
    sameSite(catalogHref, first.finalUrl) &&
    firstKind !== 'catalog' &&
    (firstKind === 'chapter' || first.hasNovelMeta || first.chapterLinks.length >= 3);

  if (shouldOpenCatalog) {
    catalog = await readExtracted(page, catalogHref);
  }

  const catalogKind = catalog ? classifyExtract(catalog) : null;
  const listPage = catalogKind === 'catalog' ? catalog : firstKind === 'catalog' ? first : null;
  const looksLikeChapterBody =
    first.contentChars >= 80 && (isChapterTitle(first.h1) || isChapterTitle(first.contentTitle));
  const contentPage = firstKind === 'chapter' || looksLikeChapterBody ? first : null;
  if (!listPage && !contentPage) {
    return null;
  }

  const extra = contentPage
    ? {
        id: contentPage.finalUrl,
        title: contentPage.contentTitle || contentPage.h1 || '正文',
        url: contentPage.finalUrl,
      }
    : undefined;
  const siblingLinks =
    !listPage && first.chapterLinks.length >= 8 && !linksLookLikeOneBook(first.chapterLinks)
      ? []
      : first.chapterLinks;
  const linkSource = listPage ? listPage.chapterLinks : siblingLinks;
  let chapters = chaptersFromLinks(linkSource, extra && isChapterTitle(extra.title) ? extra : undefined);
  if (!chapters.length && contentPage && contentPage.contentChars >= 80) {
    const title = contentPage.contentTitle || contentPage.h1 || '正文';
    chapters = [{ id: contentPage.finalUrl, title, url: contentPage.finalUrl }];
  }
  if (!chapters.length) {
    return null;
  }

  const meta = listPage || contentPage!;
  const catalogUrl = (listPage && listPage.finalUrl) || first.catalogUrl || first.finalUrl;
  const book = bookFromExtract(meta, first.finalUrl, catalogUrl, chapters);
  if (!book.title || book.title === '未命名小说') {
    const fallback = bookFromExtract(first, first.finalUrl, catalogUrl, chapters);
    if (fallback.title && fallback.title !== '未命名小说') {
      book.title = fallback.title;
    }
  }
  const listPages = fillMissingAscPages(listPage?.listPages || []);
  book.listPages = listPages;
  const total = Math.max(listPage?.chapterTotal || 0, chapters.length);
  if (total > 0) {
    book.wordCount = `${total} 章`;
  }
  if (!book.latestChapter && chapters.length) {
    book.latestChapter = chapters[chapters.length - 1].title;
  }
  if (!book.coverUrl && (listPage?.coverUrl || first.coverUrl)) {
    book.coverUrl = listPage?.coverUrl || first.coverUrl;
  }
  if (!book.updateTime && (listPage?.updateTime || first.updateTime)) {
    book.updateTime = listPage?.updateTime || first.updateTime;
  }
  return { book, chapters };
}

export async function searchWeb(query: string): Promise<WebResult[]> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'zh-CN',
    userAgent: UA,
  });
  const page = await context.newPage();
  try {
    const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(query);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('li.b_algo', { timeout: 15000 });
    const raw = await page.$$eval('li.b_algo', (items: Element[]) => {
      return items
        .slice(0, 10)
        .map((li) => {
          const a = li.querySelector('h2 a');
          const cap = li.querySelector('.b_caption p, .b_caption');
          const href = a ? a.getAttribute('href') || '' : '';
          const title = a ? (a.textContent || '').trim() : '';
          return {
            title,
            url: href,
            snippet: (cap ? cap.textContent || '' : '').trim(),
          };
        })
        .filter((r) => r.title && /^https?:\/\//i.test(r.url));
    });
    return raw.map((r) => ({ ...r, host: hostOf(r.url) }));
  } finally {
    await context.close();
  }
}

export async function inspectWebResults(results: WebResult[]): Promise<InspectedResult[]> {
  const jobs = results
    .map((r, index) => ({ r, index }))
    .filter((item) => item.r && /^https?:\/\//i.test(item.r.url))
    .slice(0, 10);
  if (!jobs.length) {
    return results.map((r) => ({ ...r, isBook: false }));
  }

  const context = await openContext();
  try {
    const found = await mapLimit(jobs, 3, async (job) => {
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(12000);
      try {
        const analyzed = await analyzeUrl(page, job.r.url);
        return { index: job.index, analyzed };
      } catch {
        return { index: job.index, analyzed: null as AnalyzedBook | null };
      } finally {
        await page.close().catch(() => {});
      }
    });

    const byIndex = new Map<number, AnalyzedBook | null>();
    found.forEach((item) => byIndex.set(item.index, item.analyzed));
    const seen = new Set<string>();
    return results.map((r, index) => {
      const analyzed = byIndex.get(index);
      if (!analyzed) {
        return { ...r, isBook: false };
      }
      if (seen.has(analyzed.book.id)) {
        return { ...r, isBook: false };
      }
      seen.add(analyzed.book.id);
      return { ...r, isBook: true, book: analyzed.book };
    });
  } finally {
    await context.close().catch(() => {});
  }
}

export async function loadWebBookChapters(input: {
  bookId?: string;
  catalogUrl?: string;
  pageUrl?: string;
  listPages?: string[];
}): Promise<{ chapters: Chapter[]; complete: boolean }> {
  if (input.bookId) {
    const cached = recallChapters(input.bookId);
    if (cached) {
      return { chapters: cached, complete: true };
    }
  }
  const url = input.catalogUrl || input.pageUrl || '';
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('缺少书籍地址，无法读取目录。');
  }
  const context = await openContext(false);
  try {
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(12000);
    try {
      const analyzed = await analyzeUrl(page, url);
      if (!analyzed || !analyzed.chapters.length) {
        throw new Error('没有识别到这部小说的章节目录。');
      }
      const seeds = fillMissingAscPages([...(input.listPages || []), ...(analyzed.book.listPages || [])]).filter((item) =>
        /^https?:\/\//i.test(item)
      );
      let chapters = analyzed.chapters;
      if (seeds.length > 1) {
        const links = await crawlChapterLists(seeds);
        const merged = chaptersFromLinks(links);
        if (merged.length > chapters.length) {
          chapters = merged;
        }
      }
      const expected = Number((analyzed.book.wordCount || '').replace(/[^\d]/g, '')) || chapters.length;
      const complete = chapters.length >= Math.max(1, Math.floor(expected * 0.7));
      if (complete) {
        // 下拉框的区间总数往往比实际章节多（末页不满），爬全后以实际链接数为准。
        analyzed.book.wordCount = `${chapters.length} 章`;
      }
      remember(analyzed.book.id, chapters, complete);
      if (input.bookId) {
        remember(input.bookId, chapters, complete);
      }
      return { chapters, complete };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function readChapterOnPage(page: Page, url: string, fallbackTitle: string): Promise<ChapterContent> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('章节地址无效。');
  }
  let extracted: ExtractedPage | null = null;
  let reason = '页面没有打开';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page
      .waitForFunction(
        () => {
          const text = (document.body && document.body.innerText) || '';
          return text.replace(/\s/g, '').length > 40 || document.querySelectorAll('a').length > 15;
        },
        { timeout: 4000 }
      )
      .catch(() => {});
    extracted = await page.evaluate(extractNovelPage);
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  if (!extracted) {
    throw new Error('打开章节网页失败：' + reason);
  }
  const text = stripLeadingTitle(cleanNovelText(extracted.contentText), extracted.contentTitle || fallbackTitle);
  const chars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (chars < 80) {
    throw new Error('没能从该网页提取到正文。');
  }
  const title = isChapterTitle(extracted.contentTitle)
    ? extracted.contentTitle
    : fallbackTitle || extracted.contentTitle || '正文';
  return { title, content: text };
}

/** 每章用独立会话读取：连续请求同一会话容易被站点限速，返回验证页。 */
export async function loadWebChapterContent(url: string, fallbackTitle: string): Promise<ChapterContent> {
  const context = await openContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(20000);
  try {
    return await readChapterOnPage(page, url, fallbackTitle);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function disposeBrowser(): Promise<void> {
  if (browserPromise) {
    const p = browserPromise;
    browserPromise = null;
    const b = await p.catch(() => null);
    if (b) {
      await b.close().catch(() => {});
    }
  }
}
