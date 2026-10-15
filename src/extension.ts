import * as vscode from 'vscode';
import { Book, Chapter, ChapterContent, NovelSource, ShelfItem } from './types';
import { DemoSource, RemoteSource } from './novelSource';
import {
  disposeBrowser,
  inspectWebResults,
  loadWebBookChapters,
  loadWebChapterContent,
  searchWeb,
} from './webSearch';
import {
  countDownloaded,
  defaultDownloadPath,
  hasDownloadedBook,
  normalizeDownloadPath,
  readDownloaded,
  readLocalChapters,
  readReadingProgress,
  saveBookAssets,
  saveBookCatalog,
  saveDownloaded,
  saveReadingProgress,
} from './downloadStore';
import { normalizeDataPath, readSharedData, writeSharedData } from './dataStore';

const SHELF_KEY = 'moyuNovel.shelf';
const PROGRESS_KEY = 'moyuNovel.progress';
const BOOKMARKS_KEY = 'moyuNovel.bookmarks';
const THEME_KEY = 'moyuNovel.theme';
const FONT_SIZE_KEY = 'moyuNovel.fontSize';
const FONT_SIZE_MODIFIER_KEY = 'moyuNovel.fontSizeModifier';
const BOOKMARK_MODIFIER_KEY = 'moyuNovel.bookmarkModifier';
const CHAPTER_CACHE_KEY = 'moyuNovel.webChapters';
const DOWNLOAD_PATH_KEY = 'moyuNovel.downloadPath';
const AUTO_DOWNLOAD_KEY = 'moyuNovel.autoDownload';
const DOWNLOAD_TASKS_KEY = 'moyuNovel.downloadTasks';
const DATA_PATH_KEY = 'moyuNovel.dataPath';

function sourceFor(name: string): NovelSource {
  if (name === 'remote') {
    const base = vscode.workspace.getConfiguration('moyuNovel').get<string>('remoteApiBase', '');
    if (!base) {
      throw new Error('已选择远程数据源，但未配置 moyuNovel.remoteApiBase。');
    }
    return new RemoteSource(base);
  }
  return new DemoSource();
}

function configuredSource(): NovelSource {
  const name = vscode.workspace.getConfiguration('moyuNovel').get<string>('source', 'demo');
  return sourceFor(name);
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new NovelViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NovelViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('moyuNovel.open', () => {
      void vscode.commands.executeCommand(`${NovelViewProvider.viewId}.focus`);
    })
  );
}

export function deactivate() {
  void disposeBrowser();
}

class NovelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'moyuNovel.reader';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly context: vscode.ExtensionContext;
  private tasks: DownloadTask[] = [];
  private readonly runningDownloads = new Set<string>();
  private readonly pausedDownloads = new Set<string>();
  private downloadChain: Promise<void> = Promise.resolve();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    const stored = context.globalState.get(DOWNLOAD_TASKS_KEY);
    this.tasks = Array.isArray(stored)
      ? (stored as DownloadTask[]).filter((task) => task && task.book && task.book.id)
      : [];
    for (const task of this.tasks) {
      if (task.status === 'paused') {
        this.pausedDownloads.add(task.book.id);
        continue;
      }
      if (task.status === 'running' || task.status === 'queued') {
        this.enqueueDownload(task.book);
      }
    }
    void this.importSharedData();
  }

  /** 启动时把共享目录里的数据读进当前软件，实现跨软件共享。 */
  private async importSharedData(): Promise<void> {
    const root = this.dataPath();
    if (!root) {
      return;
    }
    const data = await readSharedData(root);
    if (!data) {
      return;
    }
    const g = this.context.globalState;
    if (Array.isArray(data.shelf) && data.shelf.length) {
      await g.update(SHELF_KEY, data.shelf);
    }
    if (data.progress && typeof data.progress === 'object') {
      await g.update(PROGRESS_KEY, data.progress);
    }
    if (data.bookmarks && typeof data.bookmarks === 'object') {
      await g.update(BOOKMARKS_KEY, data.bookmarks);
    }
    if (data.theme === 'light' || data.theme === 'dark' || data.theme === 'auto') {
      await g.update(THEME_KEY, data.theme);
    }
    if (typeof data.fontSize === 'number' && Number.isFinite(data.fontSize)) {
      await g.update(FONT_SIZE_KEY, Math.min(32, Math.max(12, Math.round(data.fontSize))));
    }
    if (data.fontSizeModifier === 'ctrl' || data.fontSizeModifier === 'alt' || data.fontSizeModifier === 'shift') {
      await g.update(FONT_SIZE_MODIFIER_KEY, data.fontSizeModifier);
    }
    if (data.bookmarkModifier === 'ctrl' || data.bookmarkModifier === 'alt' || data.bookmarkModifier === 'shift') {
      await g.update(BOOKMARK_MODIFIER_KEY, data.bookmarkModifier);
    }
    if (typeof data.downloadPath === 'string' && data.downloadPath.trim()) {
      try {
        await g.update(DOWNLOAD_PATH_KEY, normalizeDownloadPath(data.downloadPath));
      } catch {
        // 共享目录里的路径无效时保留本地设置。
      }
    }
    if (typeof data.autoDownload === 'boolean') {
      await g.update(AUTO_DOWNLOAD_KEY, data.autoDownload);
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview, this.context.extensionUri);
    webviewView.onDidDispose(() => this.dispose(), null, this.disposables);
    webviewView.webview.onDidReceiveMessage(
      (msg: Message) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${cspSource} https: http: data:; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource}; font-src ${cspSource};" />
  <title>摸鱼小说</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div id="app"></div>
  <script src="${jsUri}"></script>
</body>
</html>`;
  }

  private async handleMessage(msg: Message) {
    try {
      switch (msg.type) {
        case 'search': {
          const source = configuredSource();
          const data = await source.search(msg.payload.query);
          this.respond(msg.requestId, true, data);
          break;
        }
        case 'webSearch': {
          const query = String(msg.payload.query || '').trim();
          if (!query) {
            this.respond(msg.requestId, true, []);
            break;
          }
          const data = await searchWeb(query);
          this.respond(msg.requestId, true, data);
          break;
        }
        case 'inspectWeb': {
          const results = Array.isArray(msg.payload.results) ? msg.payload.results : [];
          const data = await inspectWebResults(results);
          this.respond(msg.requestId, true, data);
          break;
        }
        case 'openLink': {
          const url = String(msg.payload.url || '');
          if (/^https?:\/\//i.test(url)) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
          this.respond(msg.requestId, true, null);
          break;
        }
        case 'getChapters': {
          const data = await this.fetchChapters(msg.payload as Book);
          this.respond(msg.requestId, true, { chapters: data.chapters, complete: data.complete });
          break;
        }
        case 'getContent': {
          const data = await this.loadChapterContent(msg.payload);
          this.respond(msg.requestId, true, data);
          break;
        }
        case 'getDownloadSettings': {
          this.respond(msg.requestId, true, {
            path: this.downloadPath(),
            auto: this.autoDownload(),
          });
          break;
        }
        case 'saveDownloadSettings': {
          const saved = this.saveDownloadSettings(msg.payload.path, msg.payload.auto);
          this.respond(msg.requestId, true, saved);
          break;
        }
        case 'getDataSettings': {
          this.respond(msg.requestId, true, { path: this.dataPath() });
          break;
        }
        case 'saveDataSettings': {
          const saved = this.saveDataSettings(msg.payload.path);
          this.respond(msg.requestId, true, saved);
          break;
        }
        case 'listDownloads': {
          this.respond(msg.requestId, true, this.tasks.map((task) => this.slimTask(task)));
          break;
        }
        case 'startDownload': {
          const task = this.enqueueDownload(msg.payload.book);
          this.respond(msg.requestId, true, this.slimTask(task));
          break;
        }
        case 'retryDownload': {
          const bookId = String(msg.payload.bookId || '');
          const existing = this.tasks.find((item) => item.book.id === bookId);
          if (!existing) {
            throw new Error('没有找到这个下载任务。');
          }
          const task = this.enqueueDownload(existing.book);
          this.respond(msg.requestId, true, this.slimTask(task));
          break;
        }
        case 'removeDownload': {
          const bookId = String(msg.payload.bookId || '');
          this.pausedDownloads.add(bookId);
          this.tasks = this.tasks.filter((item) => item.book.id !== bookId);
          this.persistTasks();
          this.respond(msg.requestId, true, this.tasks.map((task) => this.slimTask(task)));
          break;
        }
        case 'pauseDownload': {
          const bookId = String(msg.payload.bookId || '');
          const task = this.pauseDownload(bookId);
          this.respond(msg.requestId, true, this.slimTask(task));
          break;
        }
        case 'getShelf': {
          this.respond(msg.requestId, true, this.loadShelf());
          break;
        }
        case 'saveBook': {
          const shelf = this.saveToShelf(msg.payload.book);
          this.respond(msg.requestId, true, shelf);
          break;
        }
        case 'removeBook': {
          const shelf = this.removeFromShelf(msg.payload.bookId);
          this.respond(msg.requestId, true, shelf);
          break;
        }
        case 'getBookmarks': {
          this.respond(msg.requestId, true, this.loadBookmarks());
          break;
        }
        case 'toggleBookmark': {
          const saved = this.toggleBookmark(
            String(msg.payload.bookId || ''),
            String(msg.payload.chapterId || ''),
            String(msg.payload.title || ''),
            Number(msg.payload.chapterIndex)
          );
          this.respond(msg.requestId, true, saved);
          break;
        }
        case 'getReaderSettings': {
          this.respond(msg.requestId, true, this.readerSettings());
          break;
        }
        case 'saveReaderSettings': {
          const saved = this.saveReaderSettings(msg.payload);
          this.respond(msg.requestId, true, saved);
          break;
        }
        case 'getProgress': {
          const bookId = String(msg.payload.bookId || '');
          const disk = bookId ? await readReadingProgress(this.downloadPath(), bookId) : undefined;
          if (disk) {
            this.respond(msg.requestId, true, disk);
            break;
          }
          const progress = this.loadProgress();
          this.respond(msg.requestId, true, progress[bookId] ?? null);
          break;
        }
        case 'saveProgress': {
          this.saveProgress(msg.payload.bookId, msg.payload.chapterIndex, msg.payload.chapterId);
          this.respond(msg.requestId, true, null);
          break;
        }
        case 'getTheme': {
          this.respond(msg.requestId, true, this.loadTheme());
          break;
        }
        case 'saveTheme': {
          const raw = String(msg.payload.theme || '');
          const theme = raw === 'light' || raw === 'dark' ? raw : 'auto';
          this.context.globalState.update(THEME_KEY, theme);
          this.syncShared({ theme });
          this.respond(msg.requestId, true, theme);
          break;
        }
        default:
          this.respond(msg.requestId, false, null, '未知的消息类型：' + msg.type);
      }
    } catch (e) {
      this.respond(msg.requestId, false, null, e instanceof Error ? e.message : String(e));
    }
  }

  private respond(requestId: number, ok: boolean, data: unknown, error?: string) {
    void this.view?.webview.postMessage({ type: 'response', requestId, ok, data, error });
  }

  private loadShelf(): ShelfItem[] {
    return (this.context.globalState.get(SHELF_KEY) as ShelfItem[] | undefined) ?? [];
  }

  private saveToShelf(book: Book): ShelfItem[] {
    const shelf = this.loadShelf();
    if (!shelf.some((it) => it.book.id === book.id)) {
      shelf.unshift({
        book,
        addedAt: Date.now(),
        lastReadChapterIndex: 0,
      });
    }
    this.context.globalState.update(SHELF_KEY, shelf);
    void this.context.globalState.update(SHELF_KEY, shelf);
    this.syncShared({ shelf });
    return shelf;
  }

  private removeFromShelf(bookId: string): ShelfItem[] {
    const shelf = this.loadShelf().filter((it) => it.book.id !== bookId);
    this.context.globalState.update(SHELF_KEY, shelf);
    this.syncShared({ shelf });
    return shelf;
  }

  private loadProgress(): Record<string, { chapterIndex: number; chapterId?: string }> {
    return (this.context.globalState.get(PROGRESS_KEY) as Record<string, { chapterIndex: number; chapterId?: string }> | undefined) ?? {};
  }

  private saveProgress(bookId: string, chapterIndex: number, chapterId?: string) {
    const progress = this.loadProgress();
    progress[bookId] = { chapterIndex, chapterId };
    this.context.globalState.update(PROGRESS_KEY, progress);
    this.syncShared({ progress });
    const book =
      this.tasks.find((task) => task.book.id === bookId)?.book ||
      this.loadShelf().find((item) => item.book.id === bookId)?.book;
    void saveReadingProgress({
      root: this.downloadPath(),
      bookId,
      bookTitle: book?.title,
      chapterIndex,
      chapterId,
    });
  }

  private async fetchChapters(
    book: Book & { bookId?: string },
    options?: { skipLocal?: boolean }
  ): Promise<{ chapters: Chapter[]; complete: boolean }> {
    const bookId = String(book.id || book.bookId || '');
    if (!options?.skipLocal) {
      const downloaded = await hasDownloadedBook(this.downloadPath(), bookId);
      const finishedTask = this.tasks.some((task) => task.book.id === bookId && task.status === 'done');
      if (downloaded || finishedTask) {
        const local = await readLocalChapters(this.downloadPath(), bookId);
        if (local && local.length) {
          this.cacheChapters(bookId, local, true);
          return { chapters: local, complete: true };
        }
      }
    }
    if (book.source === 'web') {
      const fresh = this.readChapterCache(bookId, true);
      if (fresh) {
        return { chapters: fresh, complete: true };
      }
      try {
        const listPages = Array.isArray(book.listPages) ? book.listPages.filter((item) => typeof item === 'string') : [];
        const result = await loadWebBookChapters({
          bookId,
          catalogUrl: String(book.catalogUrl || ''),
          pageUrl: String(book.pageUrl || ''),
          listPages,
        });
        this.cacheChapters(bookId, result.chapters, result.complete);
        return { chapters: result.chapters, complete: result.complete };
      } catch (e) {
        const local = await readLocalChapters(this.downloadPath(), bookId);
        if (local && local.length) {
          return { chapters: local, complete: true };
        }
        const cached = this.readChapterCache(bookId, false);
        if (cached) {
          return { chapters: cached, complete: true };
        }
        throw e;
      }
    }
    const chapters = await sourceFor(String(book.source || 'demo')).getChapters(bookId);
    return { chapters, complete: true };
  }

  private enqueueDownload(raw: Book): DownloadTask {
    const book = raw || ({} as Book);
    if (!book.id) {
      throw new Error('缺少书籍，无法下载。');
    }
    this.pausedDownloads.delete(book.id);
    let task = this.tasks.find((item) => item.book.id === book.id);
    if (!task) {
      task = { book, done: 0, pending: 0, total: 0, status: 'queued', error: '' };
      this.tasks.unshift(task);
    } else {
      task.book = book;
      if (task.status !== 'running') {
        task.status = 'queued';
        task.error = '';
      }
    }
    this.persistTasks();
    this.pushTask(task);
    if (!this.runningDownloads.has(book.id)) {
      const bookId = book.id;
      this.downloadChain = this.downloadChain.then(() => this.runDownload(bookId)).catch(() => undefined);
    }
    return task;
  }

  private pauseDownload(bookId: string): DownloadTask {
    const task = this.tasks.find((item) => item.book.id === bookId);
    if (!task) {
      throw new Error('没有找到这个下载任务。');
    }
    if (task.status !== 'running' && task.status !== 'queued') {
      throw new Error('这本书当前没有在下载。');
    }
    this.pausedDownloads.add(bookId);
    task.status = 'paused';
    task.error = '';
    this.persistTasks();
    this.pushTask(task);
    return task;
  }

  private async runDownload(bookId: string): Promise<void> {
    const task = this.tasks.find((item) => item.book.id === bookId);
    if (!task || this.runningDownloads.has(bookId) || this.pausedDownloads.has(bookId)) {
      return;
    }
    this.runningDownloads.add(bookId);
    task.status = 'running';
    task.error = '';
    this.persistTasks();
    this.pushTask(task);
    let stoppedByPause = false;
    try {
      const chapters = (await this.fetchChapters(task.book, { skipLocal: true })).chapters;
      if (this.pausedDownloads.has(bookId)) {
        stoppedByPause = true;
        task.status = 'paused';
        return;
      }
      await saveBookCatalog({
        root: this.downloadPath(),
        bookId,
        bookTitle: task.book.title,
        book: task.book,
        chapters,
        complete: false,
      });
      await saveBookAssets({
        root: this.downloadPath(),
        bookId,
        book: task.book,
      });
      task.total = chapters.length;
      const already = await countDownloaded(this.downloadPath(), bookId, chapters.map((chapter) => chapter.id));
      task.done = already;
      task.pending = Math.max(chapters.length - already, 0);
      this.persistTasks();
      this.pushTask(task);
      const pullChapter = async (chapter: Chapter) => {
        if (task.book.source !== 'web') {
          return sourceFor(String(task.book.source || 'demo')).getContent(bookId, chapter.id);
        }
        let last: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await loadWebChapterContent(String(chapter.url || chapter.id), chapter.title);
          } catch (e) {
            last = e;
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }
        throw last instanceof Error ? last : new Error('打开章节网页失败。');
      };
      const saveChapter = async (chapter: Chapter) => {
        const saved = await readDownloaded(this.downloadPath(), bookId, chapter.id);
        if (saved) {
          return false;
        }
        const data = await pullChapter(chapter);
        await saveDownloaded({
          root: this.downloadPath(),
          bookId,
          chapterId: chapter.id,
          bookTitle: task.book.title || '未命名小说',
          title: data.title || chapter.title,
          content: data.content,
          book: task.book,
        });
        task.done += 1;
        task.pending = Math.max(task.total - task.done, 0);
        task.error = '';
        return true;
      };
      let failed = 0;
      const noteFailure = (chapter: Chapter, e: unknown) => {
        failed += 1;
        task.error = (chapter.title || '某一章') + '：' + (e instanceof Error ? e.message : String(e));
      };
      const shouldStop = () => this.pausedDownloads.has(bookId);
      for (const chapter of chapters) {
        if (shouldStop()) {
          stoppedByPause = true;
          break;
        }
        try {
          await saveChapter(chapter);
        } catch (e) {
          noteFailure(chapter, e);
        }
        this.persistTasks();
        this.pushTask(task);
      }
      if (stoppedByPause || shouldStop()) {
        task.status = 'paused';
        task.error = '';
        return;
      }
      if (failed > 0) {
        task.status = 'error';
        task.error = '有 ' + failed + ' 章没能打开，已保存的章节会保留。再点一次下载会从剩下的章节继续。' + (task.error ? ' 最近一次：' + task.error : '');
      } else {
        task.status = task.pending === 0 ? 'done' : 'error';
        if (task.status === 'error' && !task.error) {
          task.error = '还有章节没有下载完成。';
        }
      }
      if (task.status === 'done') {
        await saveBookCatalog({
          root: this.downloadPath(),
          bookId,
          bookTitle: task.book.title,
          book: task.book,
          chapters,
          complete: true,
        });
        await saveBookAssets({
          root: this.downloadPath(),
          bookId,
          book: task.book,
        });
      }
    } catch (e) {
      if (this.pausedDownloads.has(bookId)) {
        task.status = 'paused';
        task.error = '';
      } else {
        task.status = 'error';
        task.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      this.runningDownloads.delete(bookId);
      this.persistTasks();
      this.pushTask(task);
    }
  }

  private slimTask(task: DownloadTask) {
    return {
      bookId: task.book.id,
      title: task.book.title,
      author: task.book.author,
      done: task.done,
      pending: task.pending,
      total: task.total,
      status: task.status,
      error: task.error,
    };
  }

  private persistTasks() {
    const slim = this.tasks.slice(0, 40);
    void this.context.globalState.update(DOWNLOAD_TASKS_KEY, slim);
  }

  private pushTask(task: DownloadTask) {
    void this.view?.webview.postMessage({ type: 'downloadProgress', task: this.slimTask(task) });
  }

  private downloadPath(): string {
    const stored = this.context.globalState.get(DOWNLOAD_PATH_KEY);
    if (typeof stored === 'string' && stored.trim()) {
      try {
        return normalizeDownloadPath(stored);
      } catch {
        return defaultDownloadPath();
      }
    }
    return defaultDownloadPath();
  }

  private autoDownload(): boolean {
    return this.context.globalState.get(AUTO_DOWNLOAD_KEY) === true;
  }

  private saveDownloadSettings(pathValue: unknown, autoValue: unknown): { path: string; auto: boolean } {
    const downloadPath = normalizeDownloadPath(typeof pathValue === 'string' ? pathValue : '');
    const auto = autoValue === true;
    void this.context.globalState.update(DOWNLOAD_PATH_KEY, downloadPath);
    void this.context.globalState.update(AUTO_DOWNLOAD_KEY, auto);
    this.syncShared({ downloadPath, autoDownload: auto });
    return { path: downloadPath, auto };
  }

  private dataPath(): string {
    const stored = this.context.globalState.get(DATA_PATH_KEY);
    if (typeof stored === 'string' && stored.trim()) {
      try {
        return normalizeDataPath(stored);
      } catch {
        return '';
      }
    }
    return '';
  }

  private saveDataSettings(pathValue: unknown): { path: string } {
    const dataPath = normalizeDataPath(typeof pathValue === 'string' ? pathValue : '');
    void this.context.globalState.update(DATA_PATH_KEY, dataPath);
    if (dataPath) {
      // 切到共享目录时把当前数据带过去，避免看起来像数据丢了。
      void writeSharedData(dataPath, {
        shelf: this.loadShelf(),
        progress: this.loadProgress(),
        bookmarks: this.loadBookmarks(),
        theme: this.loadTheme(),
        ...this.readerSettings(),
        downloadPath: this.downloadPath(),
        autoDownload: this.autoDownload(),
      }).catch(() => undefined);
    }
    return { path: dataPath };
  }

  private syncShared(patch: Record<string, unknown>) {
    const root = this.dataPath();
    if (!root) {
      return;
    }
    void writeSharedData(root, patch).catch(() => undefined);
  }

  private async loadChapterContent(payload: {
    source?: string;
    bookId?: string;
    chapterId?: string;
    chapterUrl?: string;
    chapterTitle?: string;
    bookTitle?: string;
  }): Promise<ChapterContent> {
    const bookId = String(payload.bookId || '');
    const chapterId = String(payload.chapterId || '');
    const root = this.downloadPath();
    const local = await readDownloaded(root, bookId, chapterId);
    if (local) {
      return local;
    }
    const data =
      payload.source === 'web'
        ? await loadWebChapterContent(String(payload.chapterUrl || chapterId), String(payload.chapterTitle || ''))
        : await sourceFor(String(payload.source || 'demo')).getContent(bookId, chapterId);
    if (this.autoDownload() && bookId && chapterId && data.content) {
      try {
        const book =
          this.tasks.find((task) => task.book.id === bookId)?.book ||
          this.loadShelf().find((item) => item.book.id === bookId)?.book;
        await saveDownloaded({
          root,
          bookId,
          chapterId,
          bookTitle: String(payload.bookTitle || book?.title || '未命名小说'),
          title: data.title,
          content: data.content,
          book,
        });
      } catch {
        // 正文已经取到，保存失败时仍返回给阅读页。
      }
    }
    return data;
  }

  private loadBookmarks(): Record<string, Bookmark[]> {
    return (this.context.globalState.get(BOOKMARKS_KEY) as Record<string, Bookmark[]> | undefined) ?? {};
  }

  private toggleBookmark(bookId: string, chapterId: string, title: string, chapterIndex: number): Bookmark[] {
    const all = this.loadBookmarks();
    const list = Array.isArray(all[bookId]) ? all[bookId].slice() : [];
    const at = list.findIndex((item) => item.chapterId === chapterId);
    if (at >= 0) {
      list.splice(at, 1);
    } else {
      list.push({ chapterId, title, chapterIndex: Number.isFinite(chapterIndex) ? chapterIndex : 0 });
      list.sort((a, b) => a.chapterIndex - b.chapterIndex);
    }
    all[bookId] = list;
    void this.context.globalState.update(BOOKMARKS_KEY, all);
    this.syncShared({ bookmarks: all });
    return list;
  }

  private readerSettings(): ReaderSettings {
    const fontSize = this.context.globalState.get(FONT_SIZE_KEY);
    const fontSizeModifier = this.context.globalState.get(FONT_SIZE_MODIFIER_KEY);
    const bookmarkModifier = this.context.globalState.get(BOOKMARK_MODIFIER_KEY);
    return {
      fontSize: typeof fontSize === 'number' ? Math.min(32, Math.max(12, Math.round(fontSize))) : 16,
      fontSizeModifier: fontSizeModifier === 'alt' || fontSizeModifier === 'shift' ? fontSizeModifier : 'ctrl',
      bookmarkModifier: bookmarkModifier === 'alt' || bookmarkModifier === 'shift' ? bookmarkModifier : 'ctrl',
    };
  }

  private saveReaderSettings(payload: any): ReaderSettings {
    const current = this.readerSettings();
    const fontSize = Math.min(32, Math.max(12, Math.round(Number(payload.fontSize) || current.fontSize)));
    const fontSizeModifier = payload.fontSizeModifier === 'alt' || payload.fontSizeModifier === 'shift' ? payload.fontSizeModifier : 'ctrl';
    const bookmarkModifier = payload.bookmarkModifier === 'alt' || payload.bookmarkModifier === 'shift' ? payload.bookmarkModifier : 'ctrl';
    const saved = { fontSize, fontSizeModifier, bookmarkModifier };
    void this.context.globalState.update(FONT_SIZE_KEY, fontSize);
    void this.context.globalState.update(FONT_SIZE_MODIFIER_KEY, fontSizeModifier);
    void this.context.globalState.update(BOOKMARK_MODIFIER_KEY, bookmarkModifier);
    this.syncShared({ fontSize, fontSizeModifier, bookmarkModifier });
    return saved;
  }

  private loadTheme(): string {
    const theme = this.context.globalState.get(THEME_KEY);
    if (theme === 'light' || theme === 'dark' || theme === 'auto') {
      return theme;
    }
    return 'auto';
  }

  private loadChapterCacheMap(): Record<string, { at: number; chapters: Chapter[]; complete?: boolean }> {
    return (this.context.globalState.get(CHAPTER_CACHE_KEY) as Record<string, { at: number; chapters: Chapter[]; complete?: boolean }> | undefined) ?? {};
  }

  private cacheChapters(bookId: string, chapters: Chapter[], complete: boolean) {
    if (!bookId || !chapters.length || !complete) {
      return;
    }
    const all = { ...this.loadChapterCacheMap() };
    all[bookId] = { at: Date.now(), chapters: chapters.slice(0, 5000), complete: true };
    const keys = Object.keys(all);
    if (keys.length > 20) {
      keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      keys.slice(0, keys.length - 20).forEach((k) => {
        delete all[k];
      });
    }
    void this.context.globalState.update(CHAPTER_CACHE_KEY, all);
  }

  private readChapterCache(bookId: string, onlyComplete: boolean): Chapter[] | undefined {
    const item = this.loadChapterCacheMap()[bookId];
    if (!item || !Array.isArray(item.chapters) || !item.chapters.length) {
      return undefined;
    }
    if (onlyComplete && !item.complete) {
      return undefined;
    }
    return item.chapters;
  }

  private dispose() {
    this.view = undefined;
    while (this.disposables.length) {
      this.disposables.pop()!.dispose();
    }
  }
}

interface DownloadTask {
  book: Book;
  done: number;
  pending: number;
  total: number;
  status: 'queued' | 'running' | 'paused' | 'done' | 'error';
  error: string;
}

interface Bookmark {
  chapterId: string;
  title: string;
  chapterIndex: number;
}

interface ReaderSettings {
  fontSize: number;
  fontSizeModifier: 'ctrl' | 'alt' | 'shift';
  bookmarkModifier: 'ctrl' | 'alt' | 'shift';
}

interface Message {
  type: string;
  requestId: number;
  payload: any;
}