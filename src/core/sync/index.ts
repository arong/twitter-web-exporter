import { signal } from '@preact/signals';
import { GM_xmlhttpRequest } from '$';

import packageJson from '@/../package.json';
import logger from '@/utils/logger';
import { db } from '../database';
import { options } from '../options';

const BATCH_SIZE = 50;
const POLL_INTERVAL = 5_000;
const MIN_BACKOFF = 5_000;
const MAX_BACKOFF = 5 * 60_000;
const REQUEST_TIMEOUT = 30_000;

export const syncPendingCount = signal(0);
export const syncLastSuccessAt = signal<number | null>(null);
export const syncLastError = signal<string | null>(null);

let running = false;
let started = false;
let backoff = 0;
let nextAttemptAt = 0;
let timer: number | null = null;

interface HttpResult {
  status: number;
  body: string;
}

function request(method: 'GET' | 'POST', url: string, data?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method,
      url,
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'X-Vault-Token': options.get('localSyncToken') ?? '',
      },
      data: data === undefined ? undefined : JSON.stringify(data),
      onload: (res) => resolve({ status: res.status, body: res.responseText }),
      onerror: () => reject(new Error(`Network error: ${url}`)),
      ontimeout: () => reject(new Error(`Request timed out: ${url}`)),
    });
  });
}

function endpoint() {
  return options.get('localSyncEndpoint') || 'http://127.0.0.1:7687/store';
}

function healthUrl() {
  return new URL('/health', endpoint()).toString();
}

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
        const res = await request('POST', endpoint(), {
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
    const res = await request('GET', healthUrl());
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
