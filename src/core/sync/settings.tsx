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
import {
  mediaLastError,
  mediaSavedCount,
  mediaState,
  mediaUsedLastHour,
  type MediaState,
} from './media';

function useMediaStateText(state: MediaState) {
  const { t } = useTranslation();
  switch (state.kind) {
    case 'off':
      return t('Off');
    case 'idle':
      return t('Nothing to download');
    case 'away':
      return t('Waiting for you to browse');
    case 'waiting':
      return t('Waiting between downloads');
    case 'downloading':
      return t('Downloading');
    case 'server':
      return t('Local server unavailable, retrying');
    case 'paused':
      return `${t('Paused until')} ${new Date(state.until).toLocaleTimeString()}`;
    case 'cap':
      return `${t('Hourly limit reached, until')} ${new Date(state.until).toLocaleTimeString()}`;
  }
}

function NumberOption({
  label,
  name,
  min,
  max,
  className,
}: {
  label: string;
  name: 'localSyncMediaHourlyLimit' | 'localSyncMediaVideoMaxMB';
  min: number;
  max: number;
  className: string;
}) {
  return (
    <label class={className}>
      <span class="label-text whitespace-nowrap">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        class="input input-bordered input-xs w-24"
        value={options.get(name)}
        onChange={(e) => {
          const value = Number((e.target as HTMLInputElement)?.value);
          if (Number.isFinite(value) && value >= min && value <= max) {
            options.set(name, Math.round(value));
          }
        }}
      />
    </label>
  );
}

interface LocalSyncSettingsProps {
  styles: { subtitle: string; block: string; item: string };
}

export function LocalSyncSettings({ styles }: LocalSyncSettingsProps) {
  const { t } = useTranslation();
  const enabled = useSignal(!!options.get('localSyncEnabled'));
  const mediaEnabled = useSignal(!!options.get('localSyncMedia'));
  const testing = useSignal(false);
  const mediaStateText = useMediaStateText(mediaState.value);

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
        <label class={styles.item}>
          <span class="label-text whitespace-nowrap">{t('Download media while browsing')}</span>
          <input
            type="checkbox"
            class="toggle toggle-primary"
            checked={mediaEnabled.value}
            onChange={(e) => {
              mediaEnabled.value = (e.target as HTMLInputElement)?.checked;
              options.set('localSyncMedia', mediaEnabled.value);
            }}
          />
        </label>
        <NumberOption
          label={t('Media per hour (video counts 5)')}
          name="localSyncMediaHourlyLimit"
          min={1}
          max={600}
          className={styles.item}
        />
        <NumberOption
          label={t('Max file size (MB)')}
          name="localSyncMediaVideoMaxMB"
          min={1}
          max={1000}
          className={styles.item}
        />
        <div class={styles.item}>
          <span class="label-text">
            {mediaStateText} · {t('Last hour:')} {mediaUsedLastHour.value} · {t('Saved:')}{' '}
            {mediaSavedCount.value}
          </span>
        </div>
        {mediaLastError.value && (
          <div class="text-xs text-error break-all py-1">{mediaLastError.value}</div>
        )}
      </div>
    </>
  );
}
