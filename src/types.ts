export interface Book {
  /** 全局唯一 id（demo: / remote: / web:） */
  id: string;
  title: string;
  author: string;
  description: string;
  category: string;
  wordCount: string;
  /** 最近更新时间 */
  updateTime?: string;
  /** 最新章节标题 */
  latestChapter?: string;
  /** 封面图片地址 */
  coverUrl?: string;
  /** 数据来源：demo、remote 或 web */
  source: string;
  /** 识别为小说的网页地址 */
  pageUrl?: string;
  /** 目录页地址，打开书架时用来刷新章节 */
  catalogUrl?: string;
  /** 分页目录的每一页。章节很多时，阅读前会把这些页都翻完 */
  listPages?: string[];
}

export interface Chapter {
  id: string;
  title: string;
  /** 网页章节地址 */
  url?: string;
}

export interface ChapterContent {
  title: string;
  content: string;
}

export interface ShelfItem {
  book: Book;
  addedAt: number;
  lastReadChapterIndex: number;
  lastReadChapterId?: string;
}

export interface NovelSource {
  readonly name: string;
  search(query: string): Promise<Book[]>;
  getChapters(bookId: string): Promise<Chapter[]>;
  getContent(bookId: string, chapterId: string): Promise<ChapterContent>;
}