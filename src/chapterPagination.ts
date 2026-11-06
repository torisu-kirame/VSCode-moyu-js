import { cleanNovelText, ExtractedPage, stripLeadingTitle } from './extractNovel';
import { ChapterContent } from './types';

export function chapterTitleKey(title: string): string {
  return title.replace(/[（(\[]\s*(?:第\s*)?\d+\s*(?:\/\s*\d+|页)(?:\s*共\s*\d+\s*页)?\s*[）)\]]/g, '')
    .replace(/\s*第\s*\d+\s*页\s*$/, '').replace(/\s+/g, '').trim();
}

// Only strip explicit page components; never treat the next chapter number as a page.
function pageAddress(raw: string): { key: string; page: number } {
  const url = new URL(raw);
  url.hash = '';
  let page = 1;
  for (const parameter of ['page', 'p', 'pageNum', 'pageno']) {
    const value = url.searchParams.get(parameter);
    if (value && /^\d+$/.test(value)) {
      page = Number(value);
      url.searchParams.delete(parameter);
    }
  }
  const match = url.pathname.match(/^(.*?)[_-](\d+)(\.[a-z0-9]+)$/i);
  if (match) {
    url.pathname = match[1] + match[3];
    page = Number(match[2]);
  }
  url.searchParams.sort();
  return { key: url.href, page };
}

export function nextContentPage(current: ExtractedPage): string | undefined {
  const base = new URL(current.finalUrl);
  const address = pageAddress(base.href);
  const candidates: Array<{ url: string; score: number }> = [];
  for (const link of current.contentPageLinks || []) {
    try {
      const url = new URL(link.href, base);
      url.hash = '';
      if (!/^https?:$/.test(url.protocol) || url.origin !== base.origin || url.href === base.href) continue;
      const label = link.title.replace(/\s+/g, '');
      const next = pageAddress(url.href);
      const sameChapterPage = next.key === address.key && next.page === address.page + 1;
      const explicitPage = /^(?:下一页|下页|下半章|继续阅读|nextpage)[>»›]*$/i.test(label);
      if (sameChapterPage || explicitPage) {
        candidates.push({ url: url.href, score: sameChapterPage ? 2 : 1 });
      }
    } catch { /* Ignore malformed navigation URLs. */ }
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.url;
}

/** Shared by online reading and downloads. Never return a known incomplete chapter as success. */
export async function collectChapterPages(
  url: string,
  fallbackTitle: string,
  readPage: (url: string) => Promise<ExtractedPage>,
  followControl?: (page: ExtractedPage) => Promise<ExtractedPage>
): Promise<ChapterContent> {
  const visited = new Set<string>();
  const bodies = new Set<string>();
  const chunks: string[] = [];
  let title = '';
  let identity = '';
  let next: string | undefined = url;
  let prefetched: ExtractedPage | undefined;
  while (next) {
    if (visited.size >= 50) throw new Error('章节分页超过 50 页，未保存不完整正文。');
    const requested = new URL(next);
    requested.hash = '';
    if (visited.has(requested.href)) throw new Error('章节分页出现循环，未保存不完整正文。');
    const extracted: ExtractedPage = prefetched || await readPage(requested.href);
    prefetched = undefined;
    const finalUrl = new URL(extracted.finalUrl);
    finalUrl.hash = '';
    if (visited.has(finalUrl.href)) throw new Error('章节分页重复跳转，未保存不完整正文。');
    const pageTitle = extracted.contentTitle || extracted.h1;
    const key = chapterTitleKey(pageTitle);
    if (chunks.length && identity && key && identity !== key) break;
    if (!chunks.length) {
      identity = key;
      title = chapterTitleKey(pageTitle || fallbackTitle) || fallbackTitle || '正文';
      // Preserve spaces in titles except for the pagination suffix.
      title = (pageTitle || fallbackTitle || title).replace(/[（(\[]\s*(?:第\s*)?\d+\s*(?:\/\s*\d+|页)\s*[）)\]]/g, '').trim();
    }
    visited.add(requested.href);
    visited.add(finalUrl.href);
    const body = stripLeadingTitle(cleanNovelText(extracted.contentText), pageTitle || fallbackTitle);
    if (!body || (chunks.length === 0 && (body.match(/[\u4e00-\u9fff]/g) || []).length < 80)) {
      throw new Error('没能从章节分页提取到正文，未保存不完整章节。');
    }
    if (bodies.has(body)) throw new Error('章节分页返回重复正文，请重试。');
    bodies.add(body);
    chunks.push(body);
    next = nextContentPage(extracted);
    if (!next && extracted.contentNextControl !== undefined) {
      if (!followControl) throw new Error('章节需要动态翻页，未保存不完整正文。');
      prefetched = await followControl(extracted);
      next = prefetched.finalUrl;
    }
  }
  return { title, content: chunks.join('\n\n') };
}
