import { generateTraceId, getClient, getCurrentScope, startIdleSpan } from '@sentry/core';
import type { Integration, Span } from '@sentry/core';
import { subscribeAppLifecycle } from '../appLifecycle';

/** Native Page lifecycle timing, also covers Taro pages registered through Page(). */
export class PageTracing implements Integration {
  public static id = 'PageTracing';
  public name = PageTracing.id;
  private _restore: () => void = () => {};
  private _unsubscribe: () => void = () => {};
  private _span: Span | undefined;
  private _page: object | undefined;
  private _active = false;

  public setupOnce(): void {
    this._active = true;
    const global = globalThis as any;
    if (typeof global.Page !== 'function') return;
    const original = global.Page;
    // Page callbacks need their native receiver; retain the integration separately.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const integration = this;
    const wrapped = function (this: unknown, config: Record<string, any>) {
      if (!integration._active) return original.call(this, config);
      if (!config || typeof config !== 'object') return original.call(this, config);
      for (const method of ['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload']) {
        const callback = config[method];
        config[method] = function (this: any, ...args: unknown[]) {
          try {
            if (method === 'onLoad' || method === 'onShow') integration._start(this, method);
          } catch {
            /* Instrumentation must never change page behavior. */
          }
          try {
            return typeof callback === 'function' ? callback.apply(this, args) : undefined;
          } finally {
            try {
              if (method === 'onReady' && integration._page === this && integration._span) {
                getClient()?.emit('idleSpanEnableAutoFinish', integration._span);
              }
              if ((method === 'onHide' || method === 'onUnload') && integration._page === this)
                integration._finish();
            } catch {
              /* Instrumentation is observational. */
            }
          }
        };
      }
      return original.call(this, config);
    };
    global.Page = wrapped;
    this._restore = () => {
      if (global.Page === wrapped) global.Page = original;
    };
    this._unsubscribe = subscribeAppLifecycle({ onHide: () => this._finish() });
  }

  private _start(page: any, lifecycle: string): void {
    if (!this._active) return;
    if (this._page === page) return;
    this._finish();
    this._page = page;
    const route = String(page.route || page.__route__ || page.$taroPath || 'unknown').split(
      /[?#]/,
    )[0]!;
    getCurrentScope().setPropagationContext({
      traceId: generateTraceId(),
      sampleRand: Math.random(),
    });
    getCurrentScope().setTransactionName(route);
    this._span = startIdleSpan(
      {
        name: route,
        op: lifecycle === 'onLoad' ? 'pageload' : 'navigation',
        forceTransaction: true,
        attributes: { 'sentry.origin': 'auto.navigation.miniapp', 'sentry.source': 'route' },
      },
      {
        idleTimeout: 1000,
        finalTimeout: 30000,
        disableAutoFinish: lifecycle === 'onLoad',
        trimIdleSpanEndTimestamp: false,
        beforeSpanEnd: (span) => {
          // Avoid ending an already-finished idle span again on hide: core restores
          // its captured parent scope when end() runs, which could clear newer work.
          if (this._span === span) this._span = undefined;
        },
      },
    );
  }

  private _finish(): void {
    this._span?.end();
    this._span = undefined;
    this._page = undefined;
  }

  public cleanup(): void {
    this._active = false;
    this._finish();
    this._unsubscribe();
    this._restore();
  }
}

export const pageTracingIntegration = (): Integration => new PageTracing();
