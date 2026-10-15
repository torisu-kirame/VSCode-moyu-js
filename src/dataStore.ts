import * as fs from 'fs';
import * as path from 'path';

const DATA_FILE = 'moyu-data.json';

export interface SharedData {
  shelf?: unknown;
  progress?: unknown;
  bookmarks?: unknown;
  theme?: unknown;
  fontSize?: unknown;
  fontSizeModifier?: unknown;
  bookmarkModifier?: unknown;
  downloadPath?: unknown;
  autoDownload?: unknown;
}

export function normalizeDataPath(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return '';
  }
  if (process.platform === 'win32') {
    if (!/^[a-zA-Z]:[\\/]/.test(raw) && !raw.startsWith('\\\\')) {
      throw new Error('数据存储路径需要是完整路径，例如 D:\\moyu-data。');
    }
  } else if (!path.isAbsolute(raw)) {
    throw new Error('数据存储路径需要是完整路径。');
  }
  return path.resolve(raw);
}

export async function readSharedData(root: string): Promise<SharedData | undefined> {
  if (!root) {
    return undefined;
  }
  try {
    const raw = await fs.promises.readFile(path.join(root, DATA_FILE), 'utf8');
    const data = JSON.parse(raw) as SharedData;
    return data && typeof data === 'object' ? data : undefined;
  } catch {
    return undefined;
  }
}

let writeChain: Promise<void> = Promise.resolve();

export function writeSharedData(root: string, data: SharedData): Promise<void> {
  const job = async () => {
    await fs.promises.mkdir(root, { recursive: true });
    const file = path.join(root, DATA_FILE);
    let merged: SharedData = { ...data };
    try {
      const prev = JSON.parse(await fs.promises.readFile(file, 'utf8')) as SharedData;
      if (prev && typeof prev === 'object') {
        merged = { ...prev, ...data };
      }
    } catch {
      // 文件不存在或损坏时直接覆盖写入。
    }
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  };
  writeChain = writeChain.then(job, job);
  return writeChain;
}
