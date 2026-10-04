import { GM_xmlhttpRequest } from '$';
import { options } from '../options';

const REQUEST_TIMEOUT = 30_000;
const UPLOAD_TIMEOUT = 10 * 60_000;

export interface HttpResult {
  status: number;
  body: string;
}

export function vaultEndpoint() {
  return options.get('localSyncEndpoint') || 'http://127.0.0.1:7687/store';
}

/**
 * Build a URL on the local sync server, e.g. `vaultUrl('/health')`.
 */
export function vaultUrl(path: string) {
  return new URL(path, vaultEndpoint()).toString();
}

/**
 * Send a request to the local sync server. Only the local server is ever
 * contacted through GM_xmlhttpRequest; media from twimg.com is fetched by the page.
 */
export function vaultRequest(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  data?: unknown,
  contentType = 'application/json',
): Promise<HttpResult> {
  const isBlob = data instanceof Blob;
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method,
      url,
      timeout: isBlob ? UPLOAD_TIMEOUT : REQUEST_TIMEOUT,
      headers: {
        'Content-Type': contentType,
        'X-Vault-Token': options.get('localSyncToken') ?? '',
      },
      data: data === undefined ? undefined : isBlob ? data : JSON.stringify(data),
      onload: (res) => resolve({ status: res.status, body: res.responseText }),
      onerror: () => reject(new Error(`Network error: ${url}`)),
      ontimeout: () => reject(new Error(`Request timed out: ${url}`)),
    });
  });
}
