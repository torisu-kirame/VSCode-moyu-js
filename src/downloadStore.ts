import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Book, Chapter, ChapterContent } from './types';

const LIBRARY_NAME = '.moyu-library.json';
const META_NAME = 'meta.json';
const CATALOG_NAME = 'catalog.json';
const PROGRESS_NAME = 'progress.json';
const CRAWL_NAME = 'crawl.json';
const MAIN_INDEX_NAME = 'index.json';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_COVER_REDIRECTS = 5;
const MAX_COVER_BYTES = 12 * 1024 * 1024;

interface LibraryBook {
  dir: string;
  title: string;
}

interface LibraryIndex {
  books: Record<string, LibraryBook>;
}

interface MainTxtIndex {
  files: Record<string, { name: string; title: string }>;
}

interface CatalogCache {
  chapters: Chapter[];
  complete?: boolean;
  updatedAt: number;
}

/** 每个书籍文件夹根部的 book.json：书籍基本信息 + 目录 + 书签 + 进度等二次检索数据。 */
export interface BookConfig {
  book?: Book;
  chapters?: Chapter[];
  chaptersComplete?: boolean;
  bookmarks?: unknown[];
  progress?: { chapterIndex: number; chapterId?: string };
  downloaded?: { done: number; total: number };
  updatedAt?: number;
}

const BOOK_CONFIG_NAME = 'book.json';

interface ProgressCache {
  chapterIndex: number;
  chapterId?: string;
  updatedAt: number;
}

let writeQueue: Promise<void> = Promise.resolve();

export function defaultDownloadPath(): string {
  return path.join(os.homedir(), 'Documents', '摸鱼小说');
}

export function normalizeDownloadPath(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return defaultDownloadPath();
  }
  if (process.platform === 'win32') {
    if (!/^[a-zA-Z]:[\\/]/.test(raw) && !raw.startsWith('\\\\')) {
      throw new Error('下载路径需要是完整路径，例如 C:\\Users\\用户名\\Documents\\摸鱼小说。');
    }
  } else if (!path.isAbsolute(raw)) {
    throw new Error('下载路径需要是完整路径。');
  }
  return path.resolve(raw);
}

/** 一次读取索引和目录，返回磁盘上实际存在的章节，避免逐章重复读文件。 */
export async function listDownloadedChapterIds(rootInput: string, bookId: string): Promise<Set<string>> {
  if (!bookId) {
    return new Set();
  }
  const bookRoot = await resolveBookRoot(rootInput, bookId);
  if (!bookRoot) {
    return new Set();
  }
  return readExistingChapterIds(bookRoot);
}

export async function countDownloaded(rootInput: string, bookId: string, chapterIds: string[]): Promise<number> {
  if (!bookId || !chapterIds.length) {
    return 0;
  }
  const downloaded = await listDownloadedChapterIds(rootInput, bookId);
  let count = 0;
  for (const chapterId of chapterIds) {
    if (downloaded.has(chapterId)) {
      count += 1;
    }
  }
  return count;
}

export async function hasDownloadedBook(rootInput: string, bookId: string): Promise<boolean> {
  if (!bookId) {
    return false;
  }
  const bookRoot = await resolveBookRoot(rootInput, bookId);
  if (!bookRoot) {
    return false;
  }
  const catalog = await readStoredCatalog(bookRoot);
  if (!catalog?.complete || !catalog.chapters.length) {
    return false;
  }
  const downloaded = await readExistingChapterIds(bookRoot);
  return catalog.chapters.every((chapter) => downloaded.has(String(chapter.id)));
}

export async function readLocalChapters(rootInput: string, bookId: string): Promise<Chapter[] | undefined> {
  if (!bookId) {
    return undefined;
  }
  const bookRoot = await resolveBookRoot(rootInput, bookId);
  if (!bookRoot) {
    return undefined;
  }
  const catalog = await readStoredCatalog(bookRoot);
  if (catalog && catalog.chapters.length) {
    return catalog.chapters.map((item) => ({
      id: String(item.id),
      title: String(item.title || '正文'),
      url: item.url ? String(item.url) : String(item.id),
    }));
  }
  const main = await readMainIndex(bookRoot);
  const chapters: Chapter[] = [];
  for (const [chapterId, entry] of Object.entries(main.files)) {
    chapters.push({
      id: chapterId,
      title: entry.title || '正文',
      url: chapterId,
    });
  }
  return chapters.length ? chapters : undefined;
}

export async function saveBookCatalog(options: {
  root: string;
  bookId: string;
  bookTitle?: string;
  book?: Book;
  chapters: Chapter[];
  complete?: boolean;
}): Promise<void> {
  if (!options.bookId || !options.chapters.length) {
    return;
  }
  await enqueue(() => writeBookCatalog(options));
}

export async function saveBookAssets(options: {
  root: string;
  bookId: string;
  book: Book;
}): Promise<void> {
  if (!options.bookId || !options.book) {
    return;
  }
  await enqueue(() => writeBookAssets(options));
}

export async function saveReadingProgress(options: {
  root: string;
  bookId: string;
  bookTitle?: string;
  chapterIndex: number;
  chapterId?: string;
}): Promise<void> {
  if (!options.bookId) {
    return;
  }
  await enqueue(async () => {
    const bookRoot = await ensureBookRoot(options.root, options.bookId, options.bookTitle || '未命名小说');
    const cacheDir = path.join(bookRoot, 'cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const payload: ProgressCache = {
      chapterIndex: options.chapterIndex,
      chapterId: options.chapterId,
      updatedAt: Date.now(),
    };
    await fs.promises.writeFile(path.join(cacheDir, PROGRESS_NAME), JSON.stringify(payload, null, 2), 'utf8');
    await patchBookConfig(bookRoot, {
      progress: { chapterIndex: options.chapterIndex, chapterId: options.chapterId },
    });
  });
}

export async function readReadingProgress(
  rootInput: string,
  bookId: string
): Promise<{ chapterIndex: number; chapterId?: string } | undefined> {
  const bookRoot = await resolveBookRoot(rootInput, bookId);
  if (!bookRoot) {
    return undefined;
  }
  const cacheDir = path.join(bookRoot, 'cache');
  const data = await readJsonIfFresh<ProgressCache>(path.join(cacheDir, PROGRESS_NAME));
  if (!data || typeof data.chapterIndex !== 'number') {
    return undefined;
  }
  return { chapterIndex: data.chapterIndex, chapterId: data.chapterId };
}

/** 更新书籍文件夹里的 book.json（合并写入）。书籍文件夹不存在时跳过。 */
export async function updateBookConfig(options: {
  root: string;
  bookId: string;
  patch: BookConfig;
}): Promise<void> {
  if (!options.bookId) {
    return;
  }
  await enqueue(async () => {
    const bookRoot = await resolveBookRoot(options.root, options.bookId);
    if (!bookRoot) {
      return;
    }
    await patchBookConfig(bookRoot, options.patch);
  });
}

export async function readBookConfig(rootInput: string, bookId: string): Promise<BookConfig | undefined> {
  const bookRoot = await resolveBookRoot(rootInput, bookId);
  if (!bookRoot) {
    return undefined;
  }
  return readJson<BookConfig>(path.join(bookRoot, BOOK_CONFIG_NAME));
}

/** 扫描下载目录下所有书籍文件夹（book.json，缺失时退回 assets/meta.json），用于跨设备重建书架。 */
export async function scanBookConfigs(rootInput: string): Promise<BookConfig[]> {
  let root: string;
  try {
    root = normalizeDownloadPath(rootInput);
  } catch {
    return [];
  }
  let dirs: string[];
  try {
    dirs = (await fs.promises.readdir(root, { withFileTypes: true }))
      .filter((item) => item.isDirectory())
      .map((item) => item.name);
  } catch {
    return [];
  }
  const candidates = await mapLimit(dirs, 8, async (dir): Promise<BookConfig | undefined> => {
    const bookRoot = path.join(root, dir);
    const config = await readJson<BookConfig>(path.join(bookRoot, BOOK_CONFIG_NAME));
    if (config?.book?.id) {
      return config;
    }
    const meta = await readJson<Record<string, unknown>>(path.join(bookRoot, 'assets', META_NAME));
    const id = meta && typeof meta.id === 'string' ? meta.id : '';
    if (!id) {
      return undefined;
    }
    const book = (meta || {}) as unknown as Book;
    const catalog = await readStoredCatalog(bookRoot);
    const progress = await readJsonIfFresh<ProgressCache>(path.join(bookRoot, 'cache', PROGRESS_NAME));
    return {
      book,
      chapters: catalog?.chapters,
      chaptersComplete: catalog?.complete,
      progress: progress ? { chapterIndex: progress.chapterIndex, chapterId: progress.chapterId } : undefined,
    };
  });
  const configs: BookConfig[] = [];
  const seen = new Set<string>();
  for (const config of candidates) {
    const id = config?.book?.id;
    if (!config || !id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    configs.push(config);
  }
  return configs;
}

async function patchBookConfig(bookRoot: string, patch: BookConfig): Promise<void> {
  const file = path.join(bookRoot, BOOK_CONFIG_NAME);
  let prev: BookConfig = {};
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as BookConfig;
    if (parsed && typeof parsed === 'object') {
      prev = parsed;
    }
  } catch {
    // 首次创建时没有旧文件。
  }
  const merged: BookConfig = { ...prev };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  merged.updatedAt = Date.now();
  await fs.promises.writeFile(file, JSON.stringify(merged, null, 2), 'utf8');
}

export async function readDownloaded(rootInput: string, bookId: string, chapterId: string): Promise<ChapterContent | undefined> {
  if (!bookId || !chapterId) {
    return undefined;
  }
  const bookRoot = await resolveBookRoot(rootInput, bookId);
  if (!bookRoot) {
    return undefined;
  }
  const index = await readMainIndex(bookRoot);
  const entry = index.files[chapterId];
  if (!entry) {
    return undefined;
  }
  const file = safeJoin(path.join(bookRoot, 'MainTXT'), entry.name);
  let raw = '';
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const title = entry.title || '正文';
  const prefix = title + '\n\n';
  const content = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (!content.trim()) {
    return undefined;
  }
  return { title, content };
}

export async function saveDownloaded(options: {
  root: string;
  bookId: string;
  chapterId: string;
  bookTitle: string;
  title: string;
  content: string;
  book?: Book;
}): Promise<void> {
  await saveDownloadedBatch({
    root: options.root,
    bookId: options.bookId,
    bookTitle: options.bookTitle,
    book: options.book,
    chapters: [
      {
        chapterId: options.chapterId,
        title: options.title,
        content: options.content,
      },
    ],
  });
}

export async function saveDownloadedBatch(options: {
  root: string;
  bookId: string;
  bookTitle: string;
  chapters: Array<{ chapterId: string; title: string; content: string }>;
  book?: Book;
}): Promise<number> {
  const chapters = options.chapters.filter((item) => item.chapterId && item.content);
  if (!options.bookId || !chapters.length) {
    return 0;
  }
  return enqueue(() => writeChapters({ ...options, chapters }));
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(job);
  writeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeChapters(options: {
  root: string;
  bookId: string;
  bookTitle: string;
  chapters: Array<{ chapterId: string; title: string; content: string }>;
  book?: Book;
}): Promise<number> {
  const bookRoot = await ensureBookRoot(options.root, options.bookId, options.bookTitle);
  if (options.book) {
    await writeBookAssets({ root: options.root, bookId: options.bookId, book: options.book, bookRoot });
  }
  const mainDir = path.join(bookRoot, 'MainTXT');
  await fs.promises.mkdir(mainDir, { recursive: true });
  const index = await readMainIndex(bookRoot);
  const unique = new Map<string, { chapterId: string; title: string; content: string }>();
  for (const chapter of options.chapters) {
    unique.set(chapter.chapterId, chapter);
  }
  let added = 0;
  const writes: Promise<void>[] = [];
  for (const chapter of unique.values()) {
    const title = chapter.title.trim() || '正文';
    let name = index.files[chapter.chapterId]?.name;
    if (!name) {
      name = safeName(title, '章节') + '-' + shortId(chapter.chapterId) + '.txt';
      added += 1;
    }
    const file = safeJoin(mainDir, name);
    writes.push(fs.promises.writeFile(file, title + '\n\n' + chapter.content, 'utf8'));
    index.files[chapter.chapterId] = { name, title };
  }
  await Promise.all(writes);
  await fs.promises.writeFile(path.join(mainDir, MAIN_INDEX_NAME), JSON.stringify(index, null, 2), 'utf8');
  const done = Object.keys(index.files).length;
  const catalog = await readStoredCatalog(bookRoot);
  await patchBookConfig(bookRoot, {
    downloaded: { done, total: catalog?.chapters.length || done },
  });
  return added;
}

async function writeBookCatalog(options: {
  root: string;
  bookId: string;
  bookTitle?: string;
  book?: Book;
  chapters: Chapter[];
  complete?: boolean;
}): Promise<void> {
  const bookRoot = await ensureBookRoot(options.root, options.bookId, options.bookTitle || options.book?.title || '未命名小说');
  if (options.book) {
    await writeBookAssets({ root: options.root, bookId: options.bookId, book: options.book, bookRoot });
  }
  const cacheDir = path.join(bookRoot, 'cache');
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const prev = await readStoredCatalog(bookRoot);
  if (prev && prev.chapters.length > options.chapters.length && prev.complete && !options.complete) {
    return;
  }
  const payload: CatalogCache = {
    chapters: options.chapters.slice(0, 5000).map((item) => ({
      id: String(item.id),
      title: String(item.title || '正文'),
      url: item.url ? String(item.url) : String(item.id),
    })),
    complete: options.complete === true || prev?.complete === true || false,
    updatedAt: Date.now(),
  };
  if (options.complete) {
    payload.complete = true;
  }
  await fs.promises.writeFile(path.join(cacheDir, CATALOG_NAME), JSON.stringify(payload, null, 2), 'utf8');
  await fs.promises.writeFile(
    path.join(cacheDir, CRAWL_NAME),
    JSON.stringify(
      {
        bookId: options.bookId,
        title: options.bookTitle || options.book?.title || '',
        chapterCount: payload.chapters.length,
        complete: payload.complete,
        updatedAt: payload.updatedAt,
      },
      null,
      2
    ),
    'utf8'
  );
  await patchBookConfig(bookRoot, {
    ...(options.book ? { book: options.book } : {}),
    chapters: payload.chapters,
    chaptersComplete: payload.complete,
  });
}

async function writeBookAssets(options: {
  root: string;
  bookId: string;
  book: Book;
  bookRoot?: string;
}): Promise<void> {
  const bookRoot =
    options.bookRoot || (await ensureBookRoot(options.root, options.bookId, options.book.title || '未命名小说'));
  const assetsDir = path.join(bookRoot, 'assets');
  await fs.promises.mkdir(assetsDir, { recursive: true });
  let coverFile = '';
  const existingMeta = await readJson<Record<string, unknown>>(path.join(assetsDir, META_NAME));
  if (existingMeta && typeof existingMeta.coverFile === 'string') {
    coverFile = existingMeta.coverFile;
  }
  const coverUrl = options.book.coverUrl || '';
  const coverIsCurrent =
    !!coverFile &&
    existingMeta?.coverUrl === coverUrl &&
    (await safeFileExists(assetsDir, coverFile));
  if (coverUrl && /^https?:\/\//i.test(coverUrl) && !coverIsCurrent) {
    try {
      const saved = await downloadCover(assetsDir, coverUrl, coverFile);
      if (saved) {
        coverFile = saved;
      }
    } catch {
      // 封面下载失败时仍保存文字信息。
    }
  }
  const meta = {
    id: options.bookId,
    title: options.book.title || '',
    author: options.book.author || '',
    category: options.book.category || '',
    description: options.book.description || '',
    wordCount: options.book.wordCount || '',
    updateTime: options.book.updateTime || '',
    latestChapter: options.book.latestChapter || '',
    coverUrl,
    coverFile,
    pageUrl: options.book.pageUrl || '',
    catalogUrl: options.book.catalogUrl || '',
    source: options.book.source || 'web',
    updatedAt: Date.now(),
  };
  await fs.promises.writeFile(path.join(assetsDir, META_NAME), JSON.stringify(meta, null, 2), 'utf8');
  await patchBookConfig(bookRoot, { book: options.book });
}

async function downloadCover(assetsDir: string, url: string, previous?: string): Promise<string> {
  const ext = guessImageExt(url);
  const fileName = previous && /\.(jpe?g|png|webp|gif)$/i.test(previous) ? previous : 'cover' + ext;
  const target = path.join(assetsDir, fileName);
  const buffer = await fetchBinary(url);
  if (!buffer.length) {
    return '';
  }
  await fs.promises.writeFile(target, buffer);
  return fileName;
}

function guessImageExt(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) {
      return '.png';
    }
    if (pathname.endsWith('.webp')) {
      return '.webp';
    }
    if (pathname.endsWith('.gif')) {
      return '.gif';
    }
  } catch {
    // 使用默认后缀
  }
  return '.jpg';
}

function fetchBinary(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('封面地址无效。'));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('封面地址无效。'));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      parsed,
      {
        timeout: 15000,
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects >= MAX_COVER_REDIRECTS) {
            reject(new Error('封面下载重定向次数过多。'));
            return;
          }
          const next = new URL(res.headers.location, parsed).href;
          fetchBinary(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error('封面下载失败：' + (res.statusCode || 0)));
          return;
        }
        const contentLength = Number(res.headers['content-length'] || 0);
        if (contentLength > MAX_COVER_BYTES) {
          res.resume();
          reject(new Error('封面文件过大。'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('error', reject);
        res.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_COVER_BYTES) {
            res.destroy(new Error('封面文件过大。'));
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('封面下载超时'));
    });
  });
}

async function ensureBookRoot(rootInput: string, bookId: string, bookTitle: string): Promise<string> {
  const root = normalizeDownloadPath(rootInput);
  await fs.promises.mkdir(root, { recursive: true });
  const library = await readLibrary(root);
  let entry = library.books[bookId];
  if (!entry) {
    const dir = uniqueBookDir(root, safeName(bookTitle, '未命名小说'), library);
    entry = { dir, title: bookTitle };
    library.books[bookId] = entry;
    await writeLibrary(root, library);
  } else if (bookTitle && entry.title !== bookTitle) {
    entry.title = bookTitle;
    await writeLibrary(root, library);
  }
  const bookRoot = safeJoin(root, entry.dir);
  await fs.promises.mkdir(path.join(bookRoot, 'assets'), { recursive: true });
  await fs.promises.mkdir(path.join(bookRoot, 'cache'), { recursive: true });
  await fs.promises.mkdir(path.join(bookRoot, 'MainTXT'), { recursive: true });
  return bookRoot;
}

async function resolveBookRoot(rootInput: string, bookId: string): Promise<string | undefined> {
  const root = normalizeDownloadPath(rootInput);
  const library = await readLibrary(root);
  const entry = library.books[bookId];
  if (!entry?.dir) {
    return undefined;
  }
  const bookRoot = safeJoin(root, entry.dir);
  try {
    const st = await fs.promises.stat(bookRoot);
    if (!st.isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return bookRoot;
}

function uniqueBookDir(root: string, base: string, library: LibraryIndex): string {
  const used = new Set(Object.values(library.books).map((item) => item.dir.toLowerCase()));
  if (!used.has(base.toLowerCase()) && !fs.existsSync(path.join(root, base))) {
    return base;
  }
  for (let i = 2; i < 1000; i++) {
    const name = base + '-' + i;
    if (!used.has(name.toLowerCase()) && !fs.existsSync(path.join(root, name))) {
      return name;
    }
  }
  return base + '-' + Date.now();
}

async function readLibrary(root: string): Promise<LibraryIndex> {
  const data = await readJson<LibraryIndex>(safeJoin(root, LIBRARY_NAME));
  if (!data || typeof data.books !== 'object' || !data.books) {
    return { books: {} };
  }
  return data;
}

async function writeLibrary(root: string, library: LibraryIndex): Promise<void> {
  await fs.promises.writeFile(safeJoin(root, LIBRARY_NAME), JSON.stringify(library, null, 2), 'utf8');
}

async function readMainIndex(bookRoot: string): Promise<MainTxtIndex> {
  const data = await readJson<MainTxtIndex>(path.join(bookRoot, 'MainTXT', MAIN_INDEX_NAME));
  if (!data || typeof data.files !== 'object' || !data.files) {
    return { files: {} };
  }
  return data;
}

async function readExistingChapterIds(bookRoot: string): Promise<Set<string>> {
  const index = await readMainIndex(bookRoot);
  let fileNames: Set<string>;
  try {
    const entries = await fs.promises.readdir(path.join(bookRoot, 'MainTXT'), { withFileTypes: true });
    fileNames = new Set(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => (process.platform === 'win32' ? entry.name.toLowerCase() : entry.name))
    );
  } catch {
    return new Set();
  }
  const ids = new Set<string>();
  for (const [chapterId, entry] of Object.entries(index.files)) {
    const name = process.platform === 'win32' ? entry?.name.toLowerCase() : entry?.name;
    if (name && fileNames.has(name)) {
      ids.add(chapterId);
    }
  }
  return ids;
}

async function readCatalogCache(bookRoot: string): Promise<CatalogCache | undefined> {
  return readJsonIfFresh<CatalogCache>(path.join(bookRoot, 'cache', CATALOG_NAME));
}

async function readStoredCatalog(bookRoot: string): Promise<CatalogCache | undefined> {
  const cached = await readCatalogCache(bookRoot);
  if (cached?.chapters?.length) {
    return cached;
  }
  const config = await readJson<BookConfig>(path.join(bookRoot, BOOK_CONFIG_NAME));
  if (!config || !Array.isArray(config.chapters) || !config.chapters.length) {
    return undefined;
  }
  return {
    chapters: config.chapters,
    complete: config.chaptersComplete === true,
    updatedAt: typeof config.updatedAt === 'number' ? config.updatedAt : 0,
  };
}

async function readJsonIfFresh<T extends { updatedAt?: number }>(file: string): Promise<T | undefined> {
  const data = await readJson<T>(file);
  if (!data) {
    return undefined;
  }
  if (typeof data.updatedAt === 'number' && Date.now() - data.updatedAt > CACHE_TTL_MS) {
    await fs.promises.unlink(file).catch(() => undefined);
    return undefined;
  }
  return data;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function safeFileExists(root: string, rel: string): Promise<boolean> {
  try {
    return await fileExists(safeJoin(root, rel));
  } catch {
    return false;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const count = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        output[index] = await worker(items[index], index);
      }
    })
  );
  return output;
}

function safeJoin(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, rel);
  const diff = path.relative(resolvedRoot, target);
  if (diff === '..' || diff.startsWith('..' + path.sep) || path.isAbsolute(diff)) {
    throw new Error('下载文件路径无效。');
  }
  return target;
}

function safeName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const cut = cleaned.slice(0, 80);
  return cut || fallback;
}

function shortId(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
