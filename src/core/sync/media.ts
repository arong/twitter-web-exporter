import { signal } from '@preact/signals';

import logger from '@/utils/logger';
import { options } from '../options';
import { vaultRequest, vaultUrl } from './http';
import { Pacer, VIDEO_WEIGHT, type PaceDecision } from './pacing';

const ALLOWED_PREFIXES = ['https://pbs.twimg.com/', 'https://video.twimg.com/'];
const TICK = 1_000;
const EMPTY_QUEUE_POLL = 15_000;
const MIN_BACKOFF = 5_000;
const MAX_BACKOFF = 5 * 60_000;
const DOWNLOAD_TIMEOUT = 9 * 60_000;
const STALL_TIMEOUT = 60_000;
const PROGRESS_STEP = 20 * 1024 * 1024;
// The server leases a claimed item for 10 minutes; give up on it a bit earlier.
const CLAIM_WAIT_LIMIT = 8 * 60_000;
const ACTIVITY_EVENTS = ['scroll', 'wheel', 'keydown', 'mousedown', 'click', 'touchstart'];

export type MediaState =
  | { kind: 'off' }
  | { kind: 'idle' }
  | { kind: 'away' }
  | { kind: 'waiting' }
  | { kind: 'downloading' }
  | { kind: 'server' }
  | { kind: 'paused' | 'cap'; until: number };

export const mediaState = signal<MediaState>({ kind: 'off' });
export const mediaUsedLastHour = signal(0);
export const mediaSavedCount = signal(0);
export const mediaLastError = signal<string | null>(null);

interface WantedItem {
  rest_id: string;
  idx: number;
  kind: string;
  url: string;
}

type DownloadResult =
  | { kind: 'ok'; blob: Blob }
  | { kind: 'http'; status: number }
  | { kind: 'too-large'; bytes: number }
  | { kind: 'network'; error: string };

const pacer = new Pacer(60);
let started = false;
let nextClaimAt = 0;
let serverBackoff = 0;

function enabled() {
  return !!options.get('localSyncEnabled') && !!options.get('localSyncMedia');
}

function visible() {
  return document.visibilityState === 'visible';
}

function maxBytes() {
  return (options.get('localSyncMediaVideoMaxMB') || 200) * 1024 * 1024;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function showDecision(decision: PaceDecision) {
  if (decision.ok) {
    return;
  }
  if (decision.reason === 'away') {
    mediaState.value = { kind: 'away' };
  } else if (decision.reason === 'gap') {
    mediaState.value = { kind: 'waiting' };
  } else {
    mediaState.value = { kind: decision.reason, until: decision.until };
  }
}

function serverFailed(message: string) {
  mediaLastError.value = message;
  serverBackoff = serverBackoff ? Math.min(serverBackoff * 2, MAX_BACKOFF) : MIN_BACKOFF;
  nextClaimAt = Date.now() + serverBackoff;
  mediaState.value = { kind: 'server' };
}

function guessContentType(url: string) {
  const format = new URL(url).searchParams.get('format');
  const ext = format ?? url.split('?')[0]?.split('.').pop() ?? '';
  const types: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
  };
  return types[ext.toLowerCase()] ?? 'application/octet-stream';
}

async function claim(): Promise<WantedItem | null> {
  const res = await vaultRequest('GET', vaultUrl('/media/wanted?limit=1'));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const { items } = JSON.parse(res.body) as { items: WantedItem[] };
  return items[0] ?? null;
}

async function reportFailed(item: WantedItem, status: number | null, error: string) {
  try {
    const res = await vaultRequest('POST', vaultUrl(`/media/${item.rest_id}/${item.idx}/failed`), {
      status,
      error,
    });
    logger.warn(`Local sync: reported failure (${status ?? error}), server said ${res.status}`);
  } catch (err) {
    logger.warn('Local sync: failed to report media failure', err);
  }
}

/**
 * Download from the page itself, like the browser loading the image, without
 * cookies (twimg.com never gets the X session cookies anyway).
 */
async function download(url: string, limit: number): Promise<DownloadResult> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort('timeout'), DOWNLOAD_TIMEOUT);
  let stallTimer = 0;
  const armStall = () => {
    window.clearTimeout(stallTimer);
    stallTimer = window.setTimeout(() => controller.abort('stalled'), STALL_TIMEOUT);
  };
  armStall();
  try {
    const res = await fetch(url, { credentials: 'omit', signal: controller.signal });
    armStall();
    const declared = Number(res.headers.get('content-length') ?? 0);
    logger.info(
      `Local sync: media response ${res.status}, ${declared ? mb(declared) : 'unknown size'}`,
    );
    if (!res.ok) {
      return { kind: 'http', status: res.status };
    }
    if (declared > limit) {
      controller.abort();
      return { kind: 'too-large', bytes: declared };
    }
    const type = res.headers.get('content-type')?.split(';')[0]?.trim() || guessContentType(url);
    if (!res.body) {
      const blob = await res.blob();
      return blob.size > limit
        ? { kind: 'too-large', bytes: blob.size }
        : { kind: 'ok', blob: new Blob([blob], { type }) };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let nextReport = PROGRESS_STEP;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      armStall();
      total += value.byteLength;
      if (total >= nextReport) {
        logger.info(`Local sync: downloaded ${mb(total)}`);
        nextReport += PROGRESS_STEP;
      }
      if (total > limit) {
        controller.abort();
        return { kind: 'too-large', bytes: total };
      }
      chunks.push(value);
    }
    return { kind: 'ok', blob: new Blob(chunks as BlobPart[], { type }) };
  } catch (err) {
    const reason = controller.signal.aborted ? String(controller.signal.reason) : String(err);
    return { kind: 'network', error: reason };
  } finally {
    window.clearTimeout(timer);
    window.clearTimeout(stallTimer);
  }
}

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function upload(item: WantedItem, blob: Blob) {
  const res = await vaultRequest(
    'PUT',
    vaultUrl(`/media/${item.rest_id}/${item.idx}`),
    blob,
    blob.type,
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

async function processItem(item: WantedItem, weight: number) {
  if (!ALLOWED_PREFIXES.some((prefix) => item.url.startsWith(prefix))) {
    await reportFailed(item, 400, `refusing to download ${item.url}`);
    return;
  }

  mediaState.value = { kind: 'downloading' };
  logger.info(`Local sync: downloading ${item.kind} ${item.rest_id}/${item.idx} ${item.url}`);
  const startedAt = Date.now();
  const result = await download(item.url, maxBytes());
  const now = Date.now();
  logger.info(`Local sync: download ${result.kind} after ${Math.round((now - startedAt) / 1000)}s`);
  pacer.recordDownload(now, weight);
  mediaUsedLastHour.value = pacer.used(now);

  switch (result.kind) {
    case 'ok':
      pacer.recordSuccess();
      try {
        await upload(item, result.blob);
        logger.info(`Local sync: uploaded ${mb(result.blob.size)} ${result.blob.type}`);
        mediaSavedCount.value += 1;
        mediaLastError.value = null;
        serverBackoff = 0;
      } catch (err) {
        logger.warn(`Local sync: upload failed: ${String(err)}`);
        serverFailed(`Upload failed: ${String(err)}`);
      }
      break;
    case 'http':
      pacer.recordHttpError(now, result.status);
      mediaLastError.value = `HTTP ${result.status}: ${item.url}`;
      await reportFailed(item, result.status, `HTTP ${result.status}`);
      break;
    case 'too-large':
      mediaLastError.value = `Too large (${Math.round(result.bytes / 1024 / 1024)} MB): ${item.url}`;
      await reportFailed(item, 413, `larger than ${maxBytes()} bytes`);
      break;
    case 'network':
      pacer.recordNetworkError(now);
      mediaLastError.value = `${result.error}: ${item.url}`;
      await reportFailed(item, null, result.error);
      break;
  }
}

async function loop() {
  for (;;) {
    try {
      await step();
    } catch (err) {
      logger.error(`Local sync: media step failed: ${String(err)}`, err);
      mediaLastError.value = String(err);
      await sleep(EMPTY_QUEUE_POLL);
    }
  }
}

async function step() {
  if (!enabled()) {
    mediaState.value = { kind: 'off' };
    await sleep(TICK);
    return;
  }

  pacer.hourlyLimit = options.get('localSyncMediaHourlyLimit') || 60;
  const now = Date.now();
  mediaUsedLastHour.value = pacer.used(now);

  const ready = pacer.decide(now, visible());
  if (!ready.ok) {
    showDecision(ready);
    await sleep(TICK);
    return;
  }
  if (now < nextClaimAt) {
    await sleep(TICK);
    return;
  }

  const item = await claim().catch((err) => {
    serverFailed(`Claim failed: ${String(err)}`);
    return undefined;
  });
  if (item === undefined) {
    return;
  }
  serverBackoff = 0;
  if (!item) {
    nextClaimAt = Date.now() + EMPTY_QUEUE_POLL;
    mediaState.value = { kind: 'idle' };
    return;
  }
  logger.info(`Local sync: claimed ${item.kind} ${item.rest_id}/${item.idx}`);

  const weight = item.kind === 'video' ? VIDEO_WEIGHT : 1;
  const deadline = Date.now() + CLAIM_WAIT_LIMIT;
  while (enabled() && Date.now() < deadline) {
    const decision = pacer.decide(Date.now(), visible(), weight);
    if (decision.ok) {
      await processItem(item, weight);
      return;
    }
    showDecision(decision);
    await sleep(TICK);
  }
  // The lease simply expires and the item comes back later.
  logger.info(`Local sync: released ${item.rest_id}/${item.idx} without downloading`);
}

/**
 * Download media wanted by the local server, one at a time, only while the
 * user is actively browsing, and upload it there.
 */
export function startMediaSync() {
  if (started) {
    return;
  }
  started = true;

  const onActivity = () => pacer.recordActivity(Date.now());
  for (const event of ACTIVITY_EVENTS) {
    window.addEventListener(event, onActivity, { passive: true, capture: true });
  }

  loop().catch((err) => logger.error('Local sync: media loop crashed', err));
}
