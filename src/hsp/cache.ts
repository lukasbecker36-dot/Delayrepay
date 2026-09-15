/**
 * Caching HSP responses by route and date.
 *
 * Everyone on the same line asks the same question, and a past date's
 * performance record never changes, so a hit is both likely and permanently
 * valid. Entries for today or later are never stored: the day's data is still
 * settling.
 *
 * What is cached is operator performance keyed by route and date - public
 * facts about trains, with nothing tying an entry to the person who asked.
 * That separation is what makes a shared cache safe here, so keep user
 * identifiers out of cache keys.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface ResponseCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

/** Builds a stable cache key from a call name and its parameters. */
export function cacheKey(call: string, params: Record<string, unknown>): string {
  const canonical = Object.keys(params)
    .sort()
    .map((name) => `${name}=${String(params[name])}`)
    .join('&');
  return `${call}:${canonical}`;
}

/**
 * Whether a response covering dates up to `latestDate` can be stored.
 *
 * Only strictly past dates qualify. Today's records are still being written.
 */
export function isCacheable(latestDate: string, today: string): boolean {
  return latestDate < today;
}

export class MemoryCache implements ResponseCache {
  readonly #entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.#entries.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.#entries.set(key, value);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/**
 * A cache on disk, so a rescan of the same route costs HSP nothing.
 *
 * Reads and writes fail soft: a broken cache should slow a scan down, never
 * break one.
 */
export class FileCache implements ResponseCache {
  readonly #directory: string;
  readonly #memory = new MemoryCache();

  constructor(directory: string) {
    this.#directory = directory;
  }

  #pathFor(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex');
    // Shard on the first byte so a year of one line's scans does not land in
    // one directory.
    return join(this.#directory, digest.slice(0, 2), `${digest}.json`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const cached = await this.#memory.get<T>(key);
    if (cached !== undefined) return cached;

    try {
      const contents = await readFile(this.#pathFor(key), 'utf8');
      const value = JSON.parse(contents) as T;
      await this.#memory.set(key, value);
      return value;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.#memory.set(key, value);
    const path = this.#pathFor(key);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value), 'utf8');
    } catch {
      // A cache that cannot write is still a working cache in memory.
    }
  }
}

/** A cache that stores nothing. Useful in tests and for live dates. */
export class NullCache implements ResponseCache {
  async get<T>(_key: string): Promise<T | undefined> {
    return undefined;
  }
  async set<T>(_key: string, _value: T): Promise<void> {
    // Intentionally empty.
  }
}
