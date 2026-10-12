import { getCurrentScope, getClient, addBreadcrumb } from '@sentry/core';
import type { Client, Event, EventHint, Integration, IntegrationFn } from '@sentry/core';

import { sdk } from '../crossPlatform';
import type { MiniappRuntimeContexts } from '../runtime-contexts';
import type { MiniappOptions } from '../types';

/**
 * System information integration.
 *
 * @deprecated 默认不启用，且其 system/device/network context 已被 `HttpContext` 与
 * `MiniappClient._prepareEvent` 覆盖。保留导出仅为向后兼容，将在 2.0 移除。请勿在新代码中使用。
 */
export class System implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'System';

  /**
   * @inheritDoc
   */
  public name: string = System.id;

  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    if ((getClient()?.getOptions() as MiniappOptions | undefined)?.enableSystemInfo === false)
      return;
    this._addNetworkContext();
    this._addLocationContext();
    this._addStorageContext();
    this._checkAppUpdate();
  }

  /** Use the owning client's defaults instead of writing stale device data into global scope. */
  public async processEvent(event: Event, _hint: EventHint, client: Client): Promise<Event> {
    if ((client.getOptions() as MiniappOptions).enableSystemInfo === false) return event;
    const owner = client as Client & {
      getRuntimeContexts?: () => PromiseLike<MiniappRuntimeContexts>;
    };
    if (!owner.getRuntimeContexts) return event;
    try {
      const defaults = await owner.getRuntimeContexts();
      event.contexts ??= {};
      for (const [name, value] of Object.entries(defaults)) {
        if (event.contexts[name] !== null)
          event.contexts[name] = { ...value, ...event.contexts[name] };
      }
      const tags: Record<string, string> = {};
      for (const [key, value] of Object.entries({
        'device.model': event.contexts['device']?.['model'],
        'device.brand': event.contexts['device']?.['brand'],
        'os.name': event.contexts['os']?.['name'],
        'os.version': event.contexts['os']?.['version'],
        'app.version': event.contexts['app']?.['app_version'],
        language: event.contexts['device']?.['language'],
      })) {
        if (typeof value === 'string' && value !== 'unknown') tags[key] = value;
      }
      event.tags = { ...tags, ...event.tags };
    } catch {
      /* Optional legacy enrichment must not stop an event. */
    }
    return event;
  }

  /**
   * Add network information to context
   */
  private _addNetworkContext(): void {
    try {
      if ((sdk() as any).getNetworkType) {
        (sdk() as any).getNetworkType({
          success: (res: { networkType: string; isConnected?: boolean }) => {
            const scope = getCurrentScope();
            scope.setContext('network', {
              type: res.networkType,
              connected: res.isConnected !== false,
            });
            scope.setTag('network.type', res.networkType);
          },
          fail: () => {
            // Ignore network type fetch errors
          },
        });
      }
    } catch (_e) {
      // Ignore errors when getting network info
    }
  }

  /**
   * Add location information to context (if available)
   */
  private _addLocationContext(): void {
    try {
      if ((sdk() as any).getLocation) {
        (sdk() as any).getLocation({
          type: 'gcj02',
          success: (res: { latitude: number; longitude: number; accuracy: number }) => {
            const scope = getCurrentScope();
            scope.setContext('location', {
              latitude: res.latitude,
              longitude: res.longitude,
              accuracy: res.accuracy,
            });
          },
          fail: () => {
            // Ignore location fetch errors (user might not grant permission)
          },
        });
      }
    } catch (_e) {
      // Ignore errors when getting location info
    }
  }
  /**
   * 采集存储配额信息
   */
  private _addStorageContext(): void {
    try {
      const miniappSdk = sdk();
      if (miniappSdk && typeof miniappSdk.getStorageInfoSync === 'function') {
        const info = miniappSdk.getStorageInfoSync();
        if (info) {
          const currentSize = info.currentSize || 0; // KB
          const limitSize = info.limitSize || 0; // KB
          const usagePercent = limitSize > 0 ? Math.round((currentSize / limitSize) * 100) : 0;

          const scope = getCurrentScope();
          scope.setContext('storage', {
            currentSize,
            limitSize,
            usagePercent,
          });

          if (usagePercent >= 80) {
            addBreadcrumb({
              category: 'storage.warning',
              message: `存储使用率 ${usagePercent}%（${currentSize}KB / ${limitSize}KB）`,
              level: 'warning',
              data: { currentSize, limitSize, usagePercent },
            });
          }
        }
      }
    } catch (_e) {
      // ignore
    }
  }

  /**
   * 检测小程序更新
   */
  private _checkAppUpdate(): void {
    try {
      const miniappSdk = sdk();
      if (miniappSdk && typeof miniappSdk.getUpdateManager === 'function') {
        const updateManager = miniappSdk.getUpdateManager();
        if (updateManager) {
          if (typeof updateManager.onCheckForUpdate === 'function') {
            updateManager.onCheckForUpdate((res: any) => {
              if (res && res.hasUpdate) {
                const scope = getCurrentScope();
                scope.setTag('has_update', 'true');

                addBreadcrumb({
                  category: 'app.update',
                  message: '检测到新版本可用',
                  level: 'info',
                  data: { hasUpdate: true },
                });
              }
            });
          }

          if (typeof updateManager.onUpdateReady === 'function') {
            updateManager.onUpdateReady(() => {
              addBreadcrumb({
                category: 'app.update',
                message: '新版本已下载完成',
                level: 'info',
                data: { updateReady: true },
              });
            });
          }
        }
      }
    } catch (_e) {
      // ignore
    }
  }
}

/**
 * System integration
 */
export const systemIntegration: IntegrationFn = () => {
  return new System();
};
