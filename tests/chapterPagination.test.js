const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectChapterPages, nextContentPage } = require('../dist/chapterPagination');
const origin = 'https://novel.test';
const text = (i) => `这是第${i}页的正文。`.repeat(20);
function page(i, count, mode = 'suffix') {
  const address = (n) => origin + (mode === 'query' ? `/book/42.html?page=${n}` : `/book/42${n === 1 ? '' : '_' + n}.html`);
  return {
    finalUrl: address(i), contentTitle: `第十章 重逢（${i}/${count}）`,
    contentText: text(i),
    contentPageLinks: [{ title: i < count ? '下一页' : '下一章', href: i < count ? address(i + 1) : origin + '/book/43.html' }],
  };
}
for (const count of [3, 5]) {
  for (const mode of ['suffix', 'query']) {
    test(`merges ${count} pages using ${mode}, without next chapter`, async () => {
      const pages = Array.from({ length: count }, (_, i) => page(i + 1, count, mode));
      let reads = 0;
      const result = await collectChapterPages(pages[0].finalUrl, '', async (url) => {
        reads++;
        return pages.find((p) => p.finalUrl === url) || assert.fail('read next chapter');
      });
      assert.equal(result.content, pages.map((p) => p.contentText).join('\n\n'));
      assert.equal(reads, count);
      assert.equal(result.title, '第十章 重逢');
    });
  }
}
test('does not accept ordinary next chapter, cross-origin links or previous page', () => {
  const p = page(3, 3);
  p.contentPageLinks.push({ title: '下一页', href: 'https://ads.test/42_4.html' }, { title: '2', href: origin + '/book/42_2.html' });
  assert.equal(nextContentPage(p), undefined);
});
test('recognizes numeric pagination and next-chapter label used for same chapter subpage', () => {
  for (const label of ['2', '下一章', '']) {
    const p = page(1, 3);
    p.contentPageLinks[0].title = label;
    assert.equal(nextContentPage(p), origin + '/book/42_2.html');
  }
});
test('rejects a failed continuation instead of returning truncated text', async () => {
  const p = page(1, 3);
  await assert.rejects(collectChapterPages(p.finalUrl, '', async (url) => {
    if (url === p.finalUrl) return p;
    throw new Error('network failure');
  }), /network failure/);
});
test('stops at chapter title change even when link incorrectly says next page', async () => {
  const p = page(1, 3);
  const result = await collectChapterPages(p.finalUrl, '', async (url) => url === p.finalUrl ? p : { ...page(2, 3), contentTitle: '第十一章 离别' });
  assert.equal(result.content, text(1));
});
test('rejects redirect loops and duplicate bodies', async () => {
  const p = page(1, 3);
  await assert.rejects(collectChapterPages(p.finalUrl, '', async () => p), /重复跳转/);
  await assert.rejects(collectChapterPages(p.finalUrl, '', async (url) => ({ ...p, finalUrl: url })), /重复正文/);
});
test('keeps short final page', async () => {
  const p = page(1, 2);
  const result = await collectChapterPages(p.finalUrl, '', async (url) => url === p.finalUrl ? p : { ...page(2, 2), contentText: '故事到这里暂时告一段落了。' });
  assert.ok(result.content.endsWith('故事到这里暂时告一段落了。'));
});
test('follows JavaScript controls only while page extraction reports remaining pages', async () => {
  const pages = Array.from({ length: 5 }, (_, i) => ({ ...page(i + 1, 5), contentPageLinks: [], contentNextControl: i < 4 ? 7 : undefined }));
  let index = 0;
  const result = await collectChapterPages(pages[0].finalUrl, '', async () => pages[0], async (current) => {
    assert.equal(current.contentNextControl, 7);
    return pages[++index];
  });
  assert.equal(index, 4);
  assert.equal(result.content, pages.map((p) => p.contentText).join('\n\n'));
});
