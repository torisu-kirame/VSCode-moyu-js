const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');

test('bookmarks render on first detail open and closing catalog preserves progress', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><div id="app"></div></body></html>');
    await page.addScriptTag({
      content: `
        window.acquireVsCodeApi = () => ({
          postMessage(message) {
            const chapters = [
              { id: 'c1', title: '第一章' },
              { id: 'c2', title: '第二章' },
              { id: 'c3', title: '第三章' }
            ];
            const responses = {
              getTheme: 'auto',
              getReaderSettings: { fontSize: 16, fontSizeModifier: 'ctrl', bookmarkModifier: 'ctrl' },
              getDownloadSettings: { path: 'D:/books', auto: false },
              getDataSettings: { path: '', effective: 'D:/books' },
              getShelf: [{ book: { id: 'b1', title: '测试小说', author: '作者', source: 'demo' }, lastReadChapterIndex: 2 }],
              getBookmarks: { b1: [{ chapterId: 'c2', chapterUrl: 'c2', title: '第二章', chapterIndex: 1 }] },
              listDownloads: [],
              getChapters: { chapters, complete: true },
              getProgress: { chapterIndex: 2, chapterId: 'c3' },
              saveProgress: null
            };
            const data = message.type === 'getContent'
              ? { title: chapters.find((item) => item.id === message.payload.chapterId).title, content: '正文内容' }
              : responses[message.type];
            queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
              data: { type: 'response', requestId: message.requestId, ok: true, data }
            })));
          }
        });
      `,
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '..', 'media', 'main.js') });

    await page.locator('.nav-item[data-view="shelf"]').click();
    await page.locator('.book-card[data-id="b1"] [data-action="enter"]').click();
    await page.locator('.bookmark-chapter').waitFor();
    assert.equal(await page.locator('.bookmark-chapter').textContent(), '第二章');

    await page.locator('[data-action="detail-catalog"]').click();
    await page.locator('#catalog:not(.hidden) .catalog-item.active').waitFor();
    assert.equal(await page.locator('.catalog-item.active').getAttribute('data-index'), '2');
    await page.locator('#catalog-close').click();
    assert.equal(await page.locator('#catalog').getAttribute('class'), 'catalog-overlay hidden');
    assert.equal(await page.locator('#chapter-title').textContent(), '第三章');
    assert.equal(await page.locator('#chapter-pos').textContent(), '3 / 3');
  } finally {
    await browser.close();
  }
});
