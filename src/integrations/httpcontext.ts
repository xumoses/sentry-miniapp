import { getClient } from '@sentry/core';
import type { Event, Integration, IntegrationFn } from '@sentry/core';

import { getSystemInfo, getAccountInfo } from '../crossPlatform';
import type { MiniappOptions } from '../types';

/** Add node request data to the event */
export class HttpContext implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'HttpContext';

  /**
   * @inheritDoc
   */
  public name: string = HttpContext.id;

  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    // This integration adds context during event processing
  }

  /**
   * @inheritDoc
   */
  public processEvent(event: Event): Event {
    if ((getClient()?.getOptions() as MiniappOptions | undefined)?.enableSystemInfo === false)
      return event;
    // runtime 与 appId 来源的 app 是本集成独有的贡献。
    // device 由 MiniappClient._prepareEvent 统一写（唯一权威，避免多处重复）；
    // network 由 NetworkStatusIntegration 写（带连接状态，且不走异步回调时序）。
    //
    // Canonical app_version is the miniapp version; host/base-library versions have separate contexts.
    const miniappVersion = this._getMiniappVersion();
    const account = getAccountInfo();

    event.contexts = {
      ...event.contexts,
      ...(event.contexts?.['runtime'] !== null
        ? {
            runtime: {
              name: 'miniapp',
              version: miniappVersion,
              ...(event.contexts?.['runtime'] || {}),
            },
          }
        : {}),
      ...(event.contexts?.['app'] !== null
        ? {
            app: {
              app_identifier: account.appId,
              name: account.appId,
              version: account.version,
              app_version: account.version,
              ...(event.contexts?.['app'] || {}),
            },
          }
        : {}),
    };

    return event;
  }

  /**
   * Get miniapp version
   */
  private _getMiniappVersion(): string {
    const sys = getSystemInfo();
    return sys?.SDKVersion || 'unknown';
  }
}

/**
 * HttpContext integration
 */
export const httpContextIntegration: IntegrationFn = () => {
  return new HttpContext();
};
