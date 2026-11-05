import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { SharedData } from './dataStore';

export interface ArchiveResult {
  path: string;
  files: number;
  bytes: number;
}

interface ExportOptions {
  outputPath: string;
  downloadRoot: string;
  data: SharedData;
  version: string;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function collectFiles(root: string, excluded: string[], relative = ''): Promise<Array<{ source: string; name: string; size: number }>> {
  const directory = path.join(root, relative);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files: Array<{ source: string; name: string; size: number }> = [];
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    const source = path.join(root, childRelative);
    if (excluded.some((item) => samePath(item, source)) || entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, excluded, childRelative)));
    } else if (entry.isFile()) {
      const stat = await fs.promises.stat(source);
      files.push({ source, name: childRelative.split(path.sep).join('/'), size: stat.size });
    }
  }
  return files;
}

export async function createDataArchive(options: ExportOptions): Promise<ArchiveResult> {
  const outputPath = path.resolve(options.outputPath);
  const tempPath = outputPath + `.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const downloads = await collectFiles(options.downloadRoot, [outputPath, tempPath]);
  const zip = new yazl.ZipFile();
  const output = fs.createWriteStream(tempPath, { flags: 'wx' });
  const completed = new Promise<void>((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    zip.outputStream.once('error', reject);
  });
  const dataBuffer = Buffer.from(JSON.stringify(options.data, null, 2), 'utf8');
  const infoBuffer = Buffer.from(
    JSON.stringify(
      {
        format: 'moyu-novel-backup',
        formatVersion: 1,
        extensionVersion: options.version,
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
  zip.addBuffer(dataBuffer, 'moyu-data.json');
  zip.addBuffer(infoBuffer, 'export-info.json');
  for (const file of downloads) {
    zip.addFile(file.source, `downloads/${file.name}`);
  }
  zip.outputStream.pipe(output);
  zip.end();
  try {
    await completed;
    await fs.promises.rm(outputPath, { force: true });
    await fs.promises.rename(tempPath, outputPath);
  } catch (error) {
    output.destroy();
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: outputPath,
    files: downloads.length + 2,
    bytes: downloads.reduce((sum, file) => sum + file.size, dataBuffer.length + infoBuffer.length),
  };
}

function safeArchiveName(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('ZIP 中包含无效的绝对路径。');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('ZIP 中包含不安全的路径。');
  }
  return parts.join('/');
}

async function copyDirectory(source: string, target: string): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
  await fs.promises.mkdir(target, { recursive: true });
  let copied = 0;
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copied += await copyDirectory(from, to);
    } else if (entry.isFile()) {
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.copyFile(from, to);
      copied++;
    }
  }
  return copied;
}

export async function importDataArchive(archivePath: string, downloadRoot: string): Promise<{ data: SharedData; files: number }> {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'moyu-novel-import-'));
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await yauzl.openPromise(archivePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true });
    let entryCount = 0;
    let totalSize = 0;
    for await (const entry of zip.eachEntry()) {
      entryCount++;
      totalSize += entry.uncompressedSize;
      if (entryCount > 200000 || totalSize > 100 * 1024 * 1024 * 1024) {
        throw new Error('ZIP 文件过大或包含过多文件。');
      }
      const name = safeArchiveName(entry.fileName);
      if (!name || (name !== 'moyu-data.json' && !name.startsWith('downloads/'))) {
        continue;
      }
      const target = path.join(tempRoot, ...name.split('/'));
      const isDirectory = entry.fileName.endsWith('/');
      const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (unixType === 0o120000) {
        throw new Error('ZIP 中不能包含符号链接。');
      }
      if (isDirectory) {
        await fs.promises.mkdir(target, { recursive: true });
        continue;
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const input = await zip.openReadStreamPromise(entry);
      await pipeline(input, fs.createWriteStream(target, { flags: 'w' }));
    }
    const dataFile = path.join(tempRoot, 'moyu-data.json');
    let data: SharedData;
    try {
      data = JSON.parse(await fs.promises.readFile(dataFile, 'utf8')) as SharedData;
    } catch {
      throw new Error('ZIP 中没有有效的 moyu-data.json。');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('ZIP 中的数据格式无效。');
    }
    const files = await copyDirectory(path.join(tempRoot, 'downloads'), downloadRoot);
    return { data, files };
  } finally {
    zip?.close();
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
