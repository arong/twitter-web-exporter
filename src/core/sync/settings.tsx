import { useSignal } from '@preact/signals';
import { IconPlugConnected, IconRefresh, IconDatabaseShare } from '@tabler/icons-preact';

import { useTranslation } from '@/i18n';
import { cx } from '@/utils/common';
import { db } from '../database';
import { options } from '../options';
import {
  retryLocalSyncNow,
  syncLastError,
  syncLastSuccessAt,
  syncPendingCount,
  testLocalSyncConnection,
} from '.';

interface LocalSyncSettingsProps {
  styles: { subtitle: string; block: string; item: string };
}

export function LocalSyncSettings({ styles }: LocalSyncSettingsProps) {
  const { t } = useTranslation();
  const enabled = useSignal(!!options.get('localSyncEnabled'));
  const testing = useSignal(false);

  const lastSuccess = syncLastSuccessAt.value
    ? new Date(syncLastSuccessAt.value).toLocaleString()
    : t('Never');

  return (
    <>
      <p class={styles.subtitle}>{t('Local Sync')}</p>
      <div class={cx(styles.block, 'flex-col')}>
        <label class={styles.item}>
          <span class="label-text whitespace-nowrap">
            {t('Send captured tweets to local server')}
          </span>
          <input
            type="checkbox"
            class="toggle toggle-primary"
            checked={enabled.value}
            onChange={(e) => {
              enabled.value = (e.target as HTMLInputElement)?.checked;
              options.set('localSyncEnabled', enabled.value);
              if (enabled.value) {
                retryLocalSyncNow();
              }
            }}
          />
        </label>
        <label class={styles.item}>
          <span class="label-text whitespace-nowrap">{t('Endpoint')}</span>
          <input
            type="text"
            class="input input-bordered input-xs w-56"
            value={options.get('localSyncEndpoint')}
            onChange={(e) => {
              options.set('localSyncEndpoint', (e.target as HTMLInputElement)?.value.trim());
            }}
          />
        </label>
        <label class={styles.item}>
          <span class="label-text whitespace-nowrap">{t('Token')}</span>
          <input
            type="password"
            class="input input-bordered input-xs w-56"
            value={options.get('localSyncToken')}
            onChange={(e) => {
              options.set('localSyncToken', (e.target as HTMLInputElement)?.value.trim());
            }}
          />
        </label>
        <div class={styles.item}>
          <span class="label-text whitespace-nowrap">
            {t('Pending:')} {syncPendingCount.value} · {t('Last sync:')} {lastSuccess}
          </span>
        </div>
        {syncLastError.value && (
          <div class="text-xs text-error break-all py-1">{syncLastError.value}</div>
        )}
        <div class={cx(styles.item, 'justify-end')}>
          <button
            class="btn btn-xs btn-neutral mr-2"
            disabled={testing.value}
            onClick={async () => {
              testing.value = true;
              const result = await testLocalSyncConnection();
              testing.value = false;
              alert(
                (result.ok ? t('Connection OK.') : t('Connection failed.')) +
                  '\n\n' +
                  result.message,
              );
            }}
          >
            <IconPlugConnected size={20} />
            {t('Test Connection')}
          </button>
          <button class="btn btn-xs btn-neutral mr-2" onClick={() => retryLocalSyncNow()}>
            <IconRefresh size={20} />
            {t('Retry Now')}
          </button>
          <button
            class="btn btn-xs btn-primary"
            onClick={async () => {
              if (!confirm(t('Queue every tweet in the local database for sync?'))) {
                return;
              }
              const count = await db.outboxEnqueueAll();
              retryLocalSyncNow();
              alert(`${t('Queued:')} ${count}`);
            }}
          >
            <IconDatabaseShare size={20} />
            {t('Queue All')}
          </button>
        </div>
      </div>
    </>
  );
}
