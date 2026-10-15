import * as http from 'http';
import * as https from 'https';
import { Book, Chapter, ChapterContent, NovelSource } from './types';
import { filterDemoBooks, getDemoChapters, getDemoContent } from './demoData';

/** 内置示例数据源：离线可用，开箱即用。 */
export class DemoSource implements NovelSource {
  readonly name = 'demo';

  async search(query: string): Promise<Book[]> {
    return filterDemoBooks(query);
  }

  async getChapters(bookId: string): Promise<Chapter[]> {
    return getDemoChapters(bookId);
  }

  async getContent(bookId: string, chapterId: string): Promise<ChapterContent> {
    return getDemoContent(bookId, chapterId);
  }
}

function httpGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https://') ? https : http;
    const req = mod.get(url, (res) => {
      if (!res.statusCode || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`请求失败（${res.statusCode}）`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('远程返回的内容不是合法 JSON'));
        }
      });
    });
    req.on('error', (e) => reject(new Error('网络请求失败：' + e.message)));
    req.setTimeout(12000, () => {
      req.destroy(new Error('请求超时'));
    });
  });
}

/**
 * 可配置的远程数据源。
 * 接口约定（均为 GET，返回 JSON）：
 *   GET {base}/search?q=关键字            -> { data: Book[] }
 *   GET {base}/book/{id}/chapters         -> { data: Chapter[] }
 *   GET {base}/book/{id}/chapter/{cid}    -> { data: { title, content } }
 */
export class RemoteSource implements NovelSource {
  readonly name = 'remote';

  constructor(private readonly baseUrl: string) {}

  private endpoint(path: string): string {
    return this.baseUrl.replace(/\/+$/, '') + path;
  }

  private async get(path: string): Promise<any> {
    const json = await httpGetJson(this.endpoint(path));
    if (!json || typeof json !== 'object') {
      throw new Error('远程接口返回格式不符合约定');
    }
    return json.data !== undefined ? json.data : json;
  }

  async search(query: string): Promise<Book[]> {
    const data = await this.get(`/search?q=${encodeURIComponent(query)}`);
    if (!Array.isArray(data)) {
      throw new Error('搜索接口返回格式不符合约定（期望 { data: Book[] }）');
    }
    return (data as Book[]).map((b) => ({ ...b, source: 'remote' }));
  }

  async getChapters(bookId: string): Promise<Chapter[]> {
    const data = await this.get(`/book/${encodeURIComponent(bookId)}/chapters`);
    if (!Array.isArray(data)) {
      throw new Error('章节接口返回格式不符合约定（期望 { data: Chapter[] }）');
    }
    return data as Chapter[];
  }

  async getContent(bookId: string, chapterId: string): Promise<ChapterContent> {
    const data = await this.get(`/book/${encodeURIComponent(bookId)}/chapter/${encodeURIComponent(chapterId)}`);
    if (!data || typeof data.title !== 'string' || typeof data.content !== 'string') {
      throw new Error('正文接口返回格式不符合约定（期望 { data: { title, content } }）');
    }
    return { title: data.title, content: data.content };
  }
}

export function createSource(source: string, remoteApiBase: string): NovelSource {
  if (source === 'remote') {
    if (!remoteApiBase) {
      throw new Error('已选择远程数据源，但未配置 moyuNovel.remoteApiBase。');
    }
    return new RemoteSource(remoteApiBase);
  }
  return new DemoSource();
}