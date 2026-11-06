import * as fs from 'fs';
import { Browser, BrowserContext, chromium, Page } from 'playwright-core';
import {
  bookFromExtract,
  chaptersFromLinks,
  classifyExtract,
  ExtractedLink,
  ExtractedPage,
  extractNovelPage,
  isChapterTitle,
  linksLookLikeOneBook,
} from './extractNovel';
import { Book, Chapter, ChapterContent } from './types';
import { collectChapterPages } from './chapterPagination';

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

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
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
const LIST_PAGE_CONCURRENCY = 2;
const INSPECT_CONCURRENCY = 4;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const INSPECT_CACHE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_INSPECT_CACHE_TTL_MS = 2 * 60 * 1000;
const searchMemory = new Map<string, CacheEntry<WebResult[]>>();
const searchInFlight = new Map<string, Promise<WebResult[]>>();
const inspectMemory = new Map<string, CacheEntry<AnalyzedBook | null>>();
const inspectInFlight = new Map<string, Promise<AnalyzedBook | null>>();

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

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number, max: number): void {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  while (cache.size > max) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function cloneAnalyzed(value: AnalyzedBook | null): AnalyzedBook | null {
  if (!value) {
    return null;
  }
  return {
    book: {
      ...value.book,
      listPages: value.book.listPages ? value.book.listPages.slice() : undefined,
    },
    chapters: value.chapters.map((chapter) => ({ ...chapter })),
  };
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

async function crawlChapterLists(
  seeds: string[],
  prefetched?: { url: string; links: ExtractedLink[] }
): Promise<ExtractedLink[]> {
  const pending = dropRedundantBookLanding(fillMissingAscPages(seeds)).slice(0, MAX_LIST_PAGES);
  const discovered = new Set(pending.map(normListUrl));
  const visited = new Set<string>(prefetched?.url ? [normListUrl(prefetched.url)] : []);
  const failed: string[] = [];
  const pageLinks = new Map<string, ExtractedLink[]>();
  if (prefetched?.url && prefetched.links.length) {
    pageLinks.set(normListUrl(prefetched.url), prefetched.links);
  }
  let cursor = 0;

  const addDiscovered = (urls: string[], queue?: string[]) => {
    for (const url of urls) {
      if (discovered.size >= MAX_LIST_PAGES) {
        break;
      }
      const key = normListUrl(url);
      if (!/^https?:\/\//i.test(url) || discovered.has(key)) {
        continue;
      }
      discovered.add(key);
      pending.push(url);
      queue?.push(url);
    }
  };

  const runWorker = async () => {
    let context = await openContext(false);
    let page = await newListPage(context);
    const rotate = async () => {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 600));
      context = await openContext(false);
      page = await newListPage(context);
    };
    try {
      while (true) {
        let url = '';
        let key = '';
        while (cursor < pending.length) {
          const candidate = pending[cursor++];
          const candidateKey = normListUrl(candidate);
          if (!visited.has(candidateKey)) {
            visited.add(candidateKey);
            url = candidate;
            key = candidateKey;
            break;
          }
        }
        if (!url) {
          return;
        }
        let data = await readListPage(page, url);
        if (!data) {
          await rotate();
          data = await readListPage(page, url);
        }
        if (!data) {
          failed.push(url);
          continue;
        }
        pageLinks.set(key, data.chapterLinks);
        addDiscovered(data.listPages || []);
        await page.waitForTimeout(160);
      }
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(LIST_PAGE_CONCURRENCY, pending.length) }, () => runWorker())
  );

  // 被限速的少量页面再用全新会话串行补一次，避免并发重试继续触发验证页。
  if (failed.length) {
    const retryQueue = failed.slice();
    let context = await openContext(false);
    let page = await newListPage(context);
    try {
      for (let i = 0; i < retryQueue.length; i++) {
        const url = retryQueue[i];
        const key = normListUrl(url);
        let data = await readListPage(page, url);
        if (!data) {
          await page.close().catch(() => {});
          await context.close().catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 600));
          context = await openContext(false);
          page = await newListPage(context);
          data = await readListPage(page, url);
        }
        if (!data) {
          continue;
        }
        pageLinks.set(key, data.chapterLinks);
        addDiscovered(data.listPages || [], retryQueue);
        await page.waitForTimeout(160);
      }
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  const links: ExtractedLink[] = [];
  const emitted = new Set<string>();
  const orderedPages = prefetched?.url ? [prefetched.url, ...pending] : pending;
  for (const url of orderedPages) {
    const key = normListUrl(url);
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    const found = pageLinks.get(key);
    if (found) {
      links.push(...found);
    }
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

async function performWebSearch(query: string): Promise<WebResult[]> {
  const context = await openContext();
  const page = await context.newPage();
  try {
    const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(query);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('li.b_algo', { state: 'attached', timeout: 15000 });
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
    const seen = new Set<string>();
    const results: WebResult[] = [];
    for (const result of raw) {
      const key = normListUrl(result.url);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({ ...result, host: hostOf(result.url) });
    }
    return results;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function searchWeb(query: string): Promise<WebResult[]> {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return [];
  }
  const key = normalized.toLocaleLowerCase('zh-CN');
  const cached = getCached(searchMemory, key);
  if (cached !== undefined) {
    return cached.map((result) => ({ ...result }));
  }
  let pending = searchInFlight.get(key);
  if (!pending) {
    pending = performWebSearch(normalized)
      .then((results) => {
        setCached(searchMemory, key, results, SEARCH_CACHE_TTL_MS, 30);
        return results;
      })
      .finally(() => {
        searchInFlight.delete(key);
      });
    searchInFlight.set(key, pending);
  }
  const results = await pending;
  return results.map((result) => ({ ...result }));
}

async function analyzeWithCache(context: BrowserContext, url: string): Promise<AnalyzedBook | null> {
  const key = normListUrl(url);
  const cached = getCached(inspectMemory, key);
  if (cached !== undefined) {
    return cloneAnalyzed(cached);
  }
  let pending = inspectInFlight.get(key);
  if (!pending) {
    pending = (async () => {
      let page: Page | undefined;
      try {
        page = await context.newPage();
        page.setDefaultNavigationTimeout(12000);
        return await analyzeUrl(page, url);
      } catch {
        return null;
      } finally {
        await page?.close().catch(() => {});
      }
      })()
      .then((analyzed) => {
        const ttl = analyzed ? INSPECT_CACHE_TTL_MS : NEGATIVE_INSPECT_CACHE_TTL_MS;
        const aliases = new Set([key]);
        if (analyzed?.book.pageUrl) {
          aliases.add(normListUrl(analyzed.book.pageUrl));
        }
        if (analyzed?.book.catalogUrl) {
          aliases.add(normListUrl(analyzed.book.catalogUrl));
        }
        aliases.forEach((alias) => setCached(inspectMemory, alias, analyzed, ttl, 120));
        return analyzed;
      })
      .finally(() => {
        inspectInFlight.delete(key);
      });
    inspectInFlight.set(key, pending);
  }
  return cloneAnalyzed(await pending);
}

export async function inspectWebResults(results: WebResult[]): Promise<InspectedResult[]> {
  const jobs = results
    .map((r, index) => ({ r, index }))
    .filter((item) => item.r && /^https?:\/\//i.test(item.r.url))
    .slice(0, 10);
  if (!jobs.length) {
    return results.map((r) => ({ ...r, isBook: false }));
  }

  const byIndex = new Map<number, AnalyzedBook | null>();
  const uncached: typeof jobs = [];
  for (const job of jobs) {
    const cached = getCached(inspectMemory, normListUrl(job.r.url));
    if (cached === undefined) {
      uncached.push(job);
    } else {
      byIndex.set(job.index, cloneAnalyzed(cached));
    }
  }
  if (uncached.length) {
    const context = await openContext();
    try {
      const found = await mapLimit(uncached, INSPECT_CONCURRENCY, async (job) => ({
        index: job.index,
        analyzed: await analyzeWithCache(context, job.r.url),
      }));
      found.forEach((item) => byIndex.set(item.index, item.analyzed));
    } finally {
      await context.close().catch(() => {});
    }
  }
  const seen = new Set<string>();
  return results.map((r, index) => {
    const analyzed = byIndex.get(index);
    if (!analyzed || seen.has(analyzed.book.id)) {
      return { ...r, isBook: false };
    }
    seen.add(analyzed.book.id);
    return { ...r, isBook: true, book: analyzed.book };
  });
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
  let analyzed: AnalyzedBook | null;
  const cachedAnalysis = getCached(inspectMemory, normListUrl(url));
  if (cachedAnalysis !== undefined) {
    analyzed = cloneAnalyzed(cachedAnalysis);
  } else {
    const context = await openContext(false);
    try {
      analyzed = await analyzeWithCache(context, url);
    } finally {
      await context.close().catch(() => {});
    }
  }
  if (!analyzed || !analyzed.chapters.length) {
    throw new Error('没有识别到这部小说的章节目录。');
  }
  const seedKeys = new Set<string>();
  const seeds = fillMissingAscPages([...(input.listPages || []), ...(analyzed.book.listPages || [])]).filter((item) => {
    const key = normListUrl(item);
    if (!/^https?:\/\//i.test(item) || seedKeys.has(key)) {
      return false;
    }
    seedKeys.add(key);
    return true;
  });
  let chapters = analyzed.chapters;
  if (seeds.length > 1) {
    const links = await crawlChapterLists(seeds, {
      url: analyzed.book.catalogUrl || url,
      links: chapters.map((chapter) => ({ title: chapter.title, href: chapter.url || chapter.id })),
    });
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
}

async function readChapterOnPage(page: Page, url: string, navigate = true): Promise<ExtractedPage> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('章节地址无效。');
  }
  let extracted: ExtractedPage | null = null;
  let reason = '页面没有打开';
  try {
    if (navigate) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page
      .waitForFunction(
        () => {
          const text = (document.body && document.body.innerText) || '';
          return text.replace(/\s/g, '').length > 40 || document.querySelectorAll('a').length > 15;
        },
        undefined,
        { timeout: 4000 }
      )
      .catch(() => {});
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        extracted = await page.evaluate(extractNovelPage);
        if (extracted.contentTitle && extracted.contentChars >= 10) break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
      if (attempt < 2) {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(700);
      }
    }
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  if (!extracted) {
    throw new Error('打开章节网页失败：' + reason);
  }
  if (looksBlocked(extracted)) throw new Error('章节分页遇到网站验证，请稍后重试。');
  return extracted;
}

/** 每章用独立会话读取：连续请求同一会话容易被站点限速，返回验证页。 */
export async function loadWebChapterContent(url: string, fallbackTitle: string): Promise<ChapterContent> {
  const context = await openContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(20000);
  try {
    return await collectChapterPages(url, fallbackTitle, (nextUrl) => readChapterOnPage(page, nextUrl), async (extracted) => {
      await Promise.all([
        page.waitForURL((next) => next.href !== extracted.finalUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }),
        page.locator('a, button').nth(extracted.contentNextControl!).click({ timeout: 5000 }),
      ]);
      return readChapterOnPage(page, page.url(), false);
    });
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
