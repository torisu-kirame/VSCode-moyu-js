import { Book, Chapter } from './types';

interface DemoBookSeed {
  id: string;
  title: string;
  author: string;
  category: string;
  wordCount: string;
  description: string;
  chapterPrefix: string[];
  chapters: number;
  actors: string[];
  scenes: string[];
}

const SEEDS: DemoBookSeed[] = [
  {
    id: 'demo:xinghai',
    title: '星海归途',
    author: '林渡',
    category: '科幻',
    wordCount: '126.8万字',
    description:
      '人类文明在群星之间流浪千年后，一艘沉默的远航舰突然折返。年轻领航员顾屿在信号深处听见了故乡的坐标，也听见了一场横跨光年的谜案。',
    chapterPrefix: ['起风', '旧歌', '深空', '回声', '暗流', '归途', '灯下', '边界', '孤城', '终章'],
    chapters: 20,
    actors: ['顾屿', '沈教授', '艾琳', '舰长'],
    scenes: ['冷白的舰桥', '沉睡的休眠舱', '布满星图的观景台', '废弃的信标站'],
  },
  {
    id: 'demo:jiudong',
    title: '剑动九霄',
    author: '陈牧',
    category: '玄幻',
    wordCount: '98.4万字',
    description:
      '落魄少年拾得半截断剑，从此踏上问剑之路。三千大道，一剑可破；诸天万界，唯我独尊。',
    chapterPrefix: ['入山', '试剑', '风云', '破境', '问心', '斩魔', '登天', '归宗'],
    chapters: 24,
    actors: ['陆尘', '柳师姐', '剑灵', '老宗主'],
    scenes: ['云雾缭绕的后山', '青石铺就的演武场', '剑冢深处', '枯坐的洞府'],
  },
  {
    id: 'demo:wudu',
    title: '雾都侦探',
    author: '沈砚',
    category: '悬疑',
    wordCount: '74.2万字',
    description:
      '雾夜连环失踪案牵出二十年前的旧案。私家侦探程决在真相与谎言之间穿行，每一步都逼近那场被大雪掩埋的秘密。',
    chapterPrefix: ['雾起', '旧卷', '迷踪', '暗哨', '回响', '黎明', '雪落'],
    chapters: 18,
    actors: ['程决', '顾探长', '林小姐', '神秘人'],
    scenes: ['雾气弥漫的老街', '堆满卷宗的办公室', '深夜的码头', '废弃的钟楼'],
  },
  {
    id: 'demo:chunri',
    title: '春日暖阳',
    author: '苏晚',
    category: '都市',
    wordCount: '52.6万字',
    description:
      '在大城市打拼的咖啡师温言，机缘巧合回到记忆中的小城。一段关于亲情、梦想与重逢的暖心故事，从这里开始。',
    chapterPrefix: ['归途', '重逢', '旧巷', '新晴', '暖意'],
    chapters: 16,
    actors: ['温言', '程屿', '阿婆', '店长'],
    scenes: ['洒满阳光的街角咖啡店', '斑驳的旧巷', '城郊的稻田', '亮着灯的小店'],
  },
];

/** 名为 "source" 的示例分页；预留扩展位 */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEMPLATES = [
  '{actor}站在{scene}里，久久没有说话。风从远处吹来，带着若有若无的凉意。',
  '“{actor}说得对。”{actor2}低声应道，目光却飘向了别处，像是藏着什么未说出口的话。',
  '这一刻，{actor}忽然明白了很多事情。那些被忽略的细节，此刻都串联成了一条清晰的线索。',
  '夜已经深了，{scene}的轮廓在昏暗中变得模糊。远处传来极轻的脚步声，一下一下，敲在心上。',
  '{actor}深吸一口气，把额前的发丝拨到耳后，用尽量平静的语气说道：“我知道了。”',
  '事情远比想象中复杂。{actor2}合上手中的东西，眉头紧紧锁在一起。',
  '那一瞬间，四周安静得出奇，只剩下空气中细微的嗡鸣，还有彼此急促的心跳。',
  '{actor}没有回头，只是摆了摆手，背影消失在{scene}的光影交错之间。',
];

export function getDemoBooks(): Book[] {
  return SEEDS.map((s) => ({
    id: s.id,
    title: s.title,
    author: s.author,
    category: s.category,
    wordCount: s.wordCount,
    description: s.description,
    source: 'demo',
  }));
}

export function filterDemoBooks(query: string): Book[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return getDemoBooks();
  }
  return getDemoBooks().filter((b) => {
    return (
      b.title.toLowerCase().includes(q) ||
      b.author.toLowerCase().includes(q) ||
      b.category.toLowerCase().includes(q) ||
      b.description.toLowerCase().includes(q)
    );
  });
}

export function getDemoChapters(bookId: string): Chapter[] {
  const seed = SEEDS.find((s) => s.id === bookId);
  if (!seed) {
    throw new Error('未找到该小说：' + bookId);
  }
  const chapters: Chapter[] = [];
  for (let i = 0; i < seed.chapters; i++) {
    const prefix = seed.chapterPrefix[i % seed.chapterPrefix.length];
    const cycles = Math.floor(i / seed.chapterPrefix.length);
    const suffix = cycles > 0 ? `（${cycles + 1}）` : '';
    chapters.push({
      id: `c${i + 1}`,
      title: `第${i + 1}章 ${prefix}${suffix}`,
    });
  }
  return chapters;
}

export function getDemoContent(bookId: string, chapterId: string): { title: string; content: string } {
  const seed = SEEDS.find((s) => s.id === bookId);
  if (!seed) {
    throw new Error('未找到该小说：' + bookId);
  }
  const chapters = getDemoChapters(bookId);
  const index = chapters.findIndex((c) => c.id === chapterId);
  if (index < 0) {
    throw new Error('未找到该章节：' + chapterId);
  }
  const chapter = chapters[index];
  const rand = mulberry32(hashCode(bookId) + index * 7919 + 1);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  const paragraphs: string[] = [];
  const lead = `　　夜色渐深，空气中浮动着淡淡的水汽。${pick(seed.actors)}独自坐在${pick(seed.scenes)}的一角，思绪飘得很远。`;
  paragraphs.push(lead);

  const count = 7 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const actor = pick(seed.actors);
    let actor2 = pick(seed.actors);
    if (actor2 === actor) {
      actor2 = seed.actors[(seed.actors.indexOf(actor) + 1) % seed.actors.length];
    }
    const tpl = pick(TEMPLATES);
    const text = tpl
      .replace(/\{actor2\}/g, actor2)
      .replace(/\{actor\}/g, actor)
      .replace(/\{scene\}/g, pick(seed.scenes));
    paragraphs.push(`　　${text}`);
  }

  const tail =
    index === chapters.length - 1
      ? '　　（全书完）'
      : '　　天色将明，一切似乎才刚刚开始。新的疑问，正在下一个转角悄然等候。';
  paragraphs.push(tail);

  return { title: chapter.title, content: paragraphs.join('\n\n') };
}