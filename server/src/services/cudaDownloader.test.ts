import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { WHISPER_CUDA_BUILD } from '../config.js';
import { cudaBuildComplete } from './cudaDownloader.js';

describe('cudaBuildComplete (AUG-140)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aug-cuda-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('missing folder is not complete', async () => {
    expect(await cudaBuildComplete(path.join(dir, 'nope'))).toBe(false);
  });

  test('whisper-cli.exe without its DLLs is not complete', async () => {
    await fs.writeFile(path.join(dir, 'whisper-cli.exe'), '');
    expect(await cudaBuildComplete(dir)).toBe(false);
  });

  test('all entries present is complete', async () => {
    await Promise.all(WHISPER_CUDA_BUILD.entries.map((e) => fs.writeFile(path.join(dir, e), '')));
    expect(await cudaBuildComplete(dir)).toBe(true);
  });
});
