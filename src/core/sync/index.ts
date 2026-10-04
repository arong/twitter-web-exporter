import { signal } from '@preact/signals';

import packageJson from '@/../package.json';
import logger from '@/utils/logger';
import { db } from '../database';
import { options } from '../options';
import { vaultEndpoint, vaultRequest, vaultUrl } from './http';
import { startMediaSync } from './media';

const BATCH_SIZE = 50;
const POLL_INTERVAL = 5_000;
const MIN_BACKOFF = 5_000;
const MAX_BACKOFF = 5 * 60_000;

export const syncPendingCount = signal(0);
export const syncLastSuccessAt = signal<number | null>(null);
export const syncLastError = signal<string | null>(null);

let running = false;
let started = false;
let backoff = 0;
let nextAttemptAt = 0;
let timer: number | null = null;

async function refreshPendingCount() {
  syncPendingCount.value = await db.outboxCount();
}

async function flush() {
  if (running || !options.get('localSyncEnabled') || Date.now() < nextAttemptAt) {
    return;
  }
  running = true;

  try {
    for (;;) {
      const batch = await db.outboxPeek(BATCH_SIZE);
      if (!batch.length) {
        break;
      }

      const ids = batch.map((item) => item.rest_id);
      const tweets = await db.getTweetsByIds(ids);

      if (tweets.length) {
        const res = await vaultRequest('POST', vaultEndpoint(), {
          client_version: packageJson.version,
          tweets,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
        }
      }

      // Ids whose tweet is gone from the local DB are dropped too.
      await db.outboxRemove(ids);
      syncLastSuccessAt.value = Date.now();
      syncLastError.value = null;
      backoff = 0;
      nextAttemptAt = 0;
    }
  } catch (error) {
    backoff = backoff ? Math.min(backoff * 2, MAX_BACKOFF) : MIN_BACKOFF;
    nextAttemptAt = Date.now() + backoff;
    syncLastError.value = (error as Error).message;
    logger.warn(`Local sync failed, retry in ${backoff / 1000}s: ${(error as Error).message}`);
  } finally {
    running = false;
    await refreshPendingCount();
  }
}

function schedule() {
  if (timer !== null) {
    return;
  }
  timer = window.setTimeout(() => {
    timer = null;
    flush();
  }, 500);
}

/**
 * Start the background loop that forwards captured tweets to the local sync server.
 */
export function startLocalSync() {
  if (started) {
    return;
  }
  started = true;

  db.onOutboxChange(() => {
    refreshPendingCount();
    schedule();
  });
  window.setInterval(flush, POLL_INTERVAL);
  refreshPendingCount();
  flush();
  startMediaSync();
}

/**
 * Retry immediately, ignoring the current backoff.
 */
export function retryLocalSyncNow() {
  nextAttemptAt = 0;
  backoff = 0;
  flush();
}

/**
 * Check that the local sync server is reachable and accepts our token.
 */
export async function testLocalSyncConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await vaultRequest('GET', vaultUrl('/health'));
    if (res.status === 401) {
      return { ok: false, message: 'Invalid token (HTTP 401)' };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, message: `HTTP ${res.status}` };
    }
    return { ok: true, message: res.body };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
