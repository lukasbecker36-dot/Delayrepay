import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cacheKey,
  FileCache,
  isCacheable,
  MemoryCache,
  NullCache,
  type ResponseCache,
} from '../src/hsp/cache.js';

describe('cacheKey', () => {
  it('is stable regardless of the order the parameters were written in', () => {
    expect(cacheKey('serviceMetrics', { to: 'VIC', from: 'BTN' })).toBe(
      cacheKey('serviceMetrics', { from: 'BTN', to: 'VIC' }),
    );
  });

  it('separates different routes and different calls', () => {
    expect(cacheKey('serviceMetrics', { from: 'BTN' })).not.toBe(
      cacheKey('serviceMetrics', { from: 'HHE' }),
    );
    expect(cacheKey('serviceMetrics', { from: 'BTN' })).not.toBe(
      cacheKey('serviceDetails', { from: 'BTN' }),
    );
  });
});

describe('isCacheable', () => {
  it('stores a past date, whose record will never change', () => {
    expect(isCacheable('2026-09-14', '2026-09-15')).toBe(true);
  });

  it('refuses today, whose record is still being written', () => {
    expect(isCacheable('2026-09-15', '2026-09-15')).toBe(false);
  });

  it('refuses a future date', () => {
    expect(isCacheable('2026-09-16', '2026-09-15')).toBe(false);
  });
});

describe('MemoryCache', () => {
  it('returns what was put in, and undefined for anything else', async () => {
    const cache = new MemoryCache();
    await cache.set('k', { a: 1 });
    expect(await cache.get('k')).toEqual({ a: 1 });
    expect(await cache.get('missing')).toBeUndefined();
  });
});

describe('NullCache', () => {
  it('never returns anything, so a live date is always refetched', async () => {
    const cache: ResponseCache = new NullCache();
    await cache.set('k', { a: 1 });
    expect(await cache.get('k')).toBeUndefined();
  });
});

describe('FileCache', () => {
  it('survives a new process, so a rescan costs HSP nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hsp-cache-'));
    try {
      await new FileCache(directory).set('route:BTN-VIC:2026-09-08', { delay: 34 });
      const reopened = new FileCache(directory);
      expect(await reopened.get('route:BTN-VIC:2026-09-08')).toEqual({ delay: 34 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('misses quietly rather than throwing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hsp-cache-'));
    try {
      expect(await new FileCache(directory).get('nothing here')).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps working in memory when it cannot write to disk', async () => {
    // A cache that cannot write should slow a scan down, never break one.
    // Rooting the cache below a regular file makes every write fail.
    const directory = await mkdtemp(join(tmpdir(), 'hsp-cache-'));
    try {
      const blocker = join(directory, 'not-a-directory');
      await writeFile(blocker, 'x', 'utf8');

      const cache = new FileCache(join(blocker, 'cache'));
      await cache.set('k', { a: 1 });
      expect(await cache.get('k')).toEqual({ a: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
