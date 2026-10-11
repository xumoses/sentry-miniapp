import {
  Client,
  Scope,
  getIsolationScope,
  getCurrentScope,
  makeOfflineTransport,
  installedIntegrations,
  eventFromUnknownInput,
  eventFromMessage as coreEventFromMessage,
  captureFeedback as coreCaptureFeedback,
  stackParserFromStackParserOptions,
  getIntegrationsToSetup,
} from '@sentry/core';
import type {
  BaseTransportOptions,
  Event,
  EventHint,
  ParameterizedString,
  SeverityLevel,
} from '@sentry/core';

import { appName, getSystemInfo, getAccountInfo } from './crossPlatform';
import { configureConsent } from './consent';
import { subscribeAppLifecycle } from './appLifecycle';
import type { MiniappOptions, ReportDialogOptions, SendFeedbackParams } from './types';
import { createMiniappTransport, createMiniappOfflineStore } from './transports';
import { SDK_NAME, SDK_VERSION } from './version';
import { miniappStackParser } from './stacktrace';

/**
 * The Sentry Miniapp SDK Client.
 *
 * @see MiniappOptions for documentation on configuration options.
 * @see SentryClient for usage documentation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class MiniappClient extends Client<any> {
  private _readConsent: () => boolean = () => true;
  private _writeConsent: (granted: boolean) => void = () => {};
  private _cleanupResources: () => void = () => {};
  private _stopTransport: () => void = () => {};
  private _integrationsCleaned = false;
  /**
   * Creates a new Miniapp SDK instance.
   *
   * @param options Configuration options for this SDK.
   */
  public constructor(options: MiniappOptions = {}) {
    // 配置隐私合规「同意门禁」。必须在 super() 之前——transport 工厂在 super() 执行期间被 core
    // 调用建立，其 shouldSend / store 需读到已就绪的 consent 状态。configureConsent 是模块函数、
    // 不触碰 this，故在 super 前调用合法。requireConsent=false 时它把门禁置为「恒放行」，行为不变。
    configureConsent({
      required: options.requireConsent === true,
      cacheLimit: options.consentCacheLimit,
      cacheMaxBytes: options.consentCacheMaxBytes,
      cacheMaxAge: options.consentCacheMaxAge,
      onDrop: options.onConsentCacheDrop,
    });

    // Each client owns its gate. A second client must not grant an older client's consent.
    let consentGranted = options.requireConsent !== true;
    let transportClosed = false;
    const scopedStore = (storeOptions: Parameters<typeof createMiniappOfflineStore>[0]) => {
      const store = createMiniappOfflineStore(storeOptions);
      return {
        ...store,
        shift: () =>
          transportClosed || options.enabled === false ? Promise.resolve(undefined) : store.shift(),
      };
    };
    const storageKey = options.dsn
      ? `sentry_offline_store:${encodeURIComponent(options.dsn)}`
      : 'sentry_offline_store';
    super({
      ...options,
      integrations: getIntegrationsToSetup({
        ...options,
        defaultIntegrations: options.defaultIntegrations ?? [],
      }),
      sendClientReports: options.sendClientReports ?? true,
      stackParser: stackParserFromStackParserOptions(options.stackParser || miniappStackParser),
      _metadata: {
        ...options._metadata,
        sdk: {
          name: SDK_NAME,
          version: SDK_VERSION,
          packages: [{ name: 'npm:@xumoses/sentry-miniapp', version: SDK_VERSION }],
          ...options._metadata?.sdk,
        },
      },
      transport: (transportOptions: BaseTransportOptions) => {
        const baseTransport = options.transport
          ? options.transport(transportOptions)
          : createMiniappTransport({
              ...transportOptions,
              ...options.transportOptions,
            });

        // 同意门禁：用 core offline transport 的 shouldSend 闸断网络（同意前 envelope 不发、
        // 转入本地缓冲），setConsent(true) 后由 transport.flush() 补发。即便用户关了
        // enableOfflineCache，requireConsent 仍需缓冲，故强制走 offline 路径；若用户传了自定义
        // transport，也要包住它，避免合规开关被高级用法绕过。
        if (options.requireConsent === true) {
          return makeOfflineTransport(() => baseTransport)({
            ...transportOptions,
            createStore: (storeOptions: any) =>
              scopedStore({
                ...storeOptions,
                storageKey,
                // 同意前缓存用独立上限 + 冷启动优先（保留最旧）淘汰，区别于弱网那套默认值。
                offlineCacheLimit: options.consentCacheLimit ?? 100,
                offlineCacheMaxAge: options.consentCacheMaxAge,
                maxBytes: options.consentCacheMaxBytes,
                evictionMode: 'preserve-oldest',
                onDrop: (reason, dropped) => {
                  try {
                    options.onConsentCacheDrop?.({ reason, dropped });
                  } catch {
                    /* observational */
                  }
                },
              }),
            // 返回 false → core 不发网络、转 shouldStore 入缓存。同意后恒为 true。
            shouldSend: () => consentGranted,
            flushAtStartup: true,
          } as any);
        }

        if (!options.transport && options.enableOfflineCache !== false) {
          return makeOfflineTransport(() => baseTransport)({
            ...transportOptions,
            createStore: (storeOptions: any) =>
              scopedStore({
                ...storeOptions,
                storageKey,
                offlineCacheLimit: options.offlineCacheLimit,
                offlineCacheMaxAge: options.offlineCacheMaxAge,
              }),
            flushAtStartup: true, // 启动时自动重试发送
          } as any);
        }

        return baseTransport;
      },
    });

    this._stopTransport = () => {
      transportClosed = true;
    };
    this._readConsent = () => options.requireConsent !== true || consentGranted;
    this._writeConsent = (granted) => {
      consentGranted = granted;
    };
    this._cleanupResources = subscribeAppLifecycle({
      onHide: () => {
        void Promise.resolve(this.flush(2000)).catch(() => {});
      },
    });
    if (options.beforeSendEvent) {
      this.on('beforeSendEvent', options.beforeSendEvent);
    }
  }

  /**
   * @inheritDoc
   */
  public eventFromException(exception: unknown, hint?: EventHint): PromiseLike<Event> {
    const event = eventFromUnknownInput(
      this,
      this.getOptions().stackParser || miniappStackParser,
      exception,
      hint,
    );
    event.level = 'error';
    return Promise.resolve(event);
  }

  public eventFromMessage(
    message: ParameterizedString,
    level: SeverityLevel = 'info',
    hint?: EventHint,
  ): PromiseLike<Event> {
    return Promise.resolve(
      coreEventFromMessage(
        this.getOptions().stackParser || miniappStackParser,
        message,
        level,
        hint,
        this.getOptions().attachStacktrace,
      ),
    );
  }

  protected override _prepareEvent(
    event: Event,
    hint?: EventHint,
    scope?: Scope,
  ): PromiseLike<Event | null> {
    event.platform = event.platform || this.getOptions().platform || 'javascript';

    // Add SDK information
    event.sdk = {
      ...event.sdk,
      name: SDK_NAME,
      packages: [
        ...((event.sdk && event.sdk.packages) || []),
        {
          name: 'npm:@xumoses/sentry-miniapp',
          version: SDK_VERSION,
        },
      ],
      version: SDK_VERSION,
    };

    // miniapp 标记是 SDK 自有的身份信息，始终写（无用户覆盖语义）。
    if (!event.contexts) {
      event.contexts = {};
    }
    event.contexts['miniapp'] = {
      platform: appName(),
      sdk_version: SDK_VERSION,
    };

    try {
      const currentScope = scope || getCurrentScope();
      const isolationScope = getIsolationScope();
      return Promise.resolve(
        super._prepareEvent(event, hint || {}, currentScope, isolationScope),
      ).then((prepared) => this._fillDefaultContexts(prepared));
    } catch (error) {
      // Fallback if scopes are not properly initialized
      if (this.getOptions().debug) {
        console.warn('[sentry-miniapp] _prepareEvent 兜底（scope 未就绪）:', error);
      }
      return Promise.resolve(this._fillDefaultContexts(event));
    }
  }

  /**
   * 用 SDK 采集的 device/os/app 填充事件上下文——**仅填充缺失的键**，不覆盖用户经
   * setContext / per-event hint / 其它集成（如 HttpContext 写的 app.name）已提供的值。
   *
   * 必须在 super._prepareEvent **之后**调用：core 以「event 优先」合并 scope contexts
   * （scopeData.js：`event.contexts = {...scope, ...event}`），若在 super 之前写，SDK 的
   * 自动值会盖掉用户的 setContext('device'/'os'/'app')。放到 super 之后按缺失填充即可两头兼顾。
   */
  private _fillDefaultContexts(event: Event | null): Event | null {
    if (!event || this.getOptions().enableSystemInfo === false) {
      return event;
    }
    const info = getSystemInfo();
    if (!event.contexts) {
      event.contexts = {};
    }
    const contexts = event.contexts;
    contexts.device = {
      brand: info?.brand || 'unknown',
      model: info?.model || 'unknown',
      screen_resolution: `${info?.screenWidth || 0}x${info?.screenHeight || 0}`,
      language: info?.language || 'unknown',
      version: info?.version || 'unknown',
      system: info?.system || 'unknown',
      platform: info?.platform || 'unknown',
      ...contexts.device,
    };
    const system = String(info?.system || '');
    const parsedSystem = /^(.*?)(?:\s+|_)(\d[\w.+_-]*)$/.exec(system);
    contexts.os = {
      name: parsedSystem?.[1] || system || 'unknown',
      ...(parsedSystem?.[2] ? { version: parsedSystem[2] } : {}),
      ...contexts.os,
    };
    contexts.app = {
      app_version: getAccountInfo().version || 'unknown',
      ...contexts.app,
    };
    contexts['miniapp_host'] = {
      name: appName(),
      version: info?.version || 'unknown',
      sdk_version: info?.SDKVersion || 'unknown',
      ...contexts['miniapp_host'],
    };
    return event;
  }

  /**
   * 关闭客户端，清理所有集成资源。
   *
   * 用公开的 `getOptions().integrations`（装配后的集成实例数组）遍历，而非基类内部的
   * `_integrations` 字段——后者是 protected、非公开契约，@sentry/core 升级若改名/改结构会
   * 静默失效。`cleanup()` 是本 SDK 集成的自定义方法（非 core Integration 接口的一部分），故做窄类型断言。
   */
  public override flush(timeout?: number): PromiseLike<boolean> {
    this._flushOutcomes();
    return super.flush(timeout);
  }

  public setConsent(granted: boolean): void {
    this._writeConsent(granted);
    if (granted) void Promise.resolve(this.getTransport()?.flush()).catch(() => {});
  }

  public getConsent(): boolean {
    return this._readConsent();
  }

  public override close(timeout?: number): PromiseLike<boolean> {
    this._stopTransport();
    this._cleanupResources();
    const integrations = this.getOptions().integrations;
    if (!this._integrationsCleaned && Array.isArray(integrations)) {
      this._integrationsCleaned = true;
      for (const integration of [...integrations].reverse()) {
        const cleanup = (integration as unknown as { cleanup?: () => void }).cleanup;
        if (typeof cleanup === 'function') {
          try {
            cleanup.call(integration);
          } catch (e) {
            if (this.getOptions().debug) {
              console.warn(`[sentry-miniapp] 集成 ${integration.name} cleanup 失败:`, e);
            }
          }
        }

        // 从 core 的进程级 setupOnce 门禁里移除本集成名，让后续 init() 能重新 setupOnce。
        // core 用 installedIntegrations（按 name 记、从不清除）守卫 setupOnce：cleanup 还原了
        // 补丁、门禁却仍记着该名，二次 init 会跳过 setup → 全局错误处理/面包屑等静默哑火（F2）。
        if (Array.isArray(installedIntegrations)) {
          const idx = installedIntegrations.indexOf(integration.name);
          if (idx !== -1) {
            installedIntegrations.splice(idx, 1);
          }
        }
      }
    }
    return Promise.resolve(super.close(timeout)).finally(() => this._stopTransport());
  }

  /**
   * @deprecated Miniapp environment does not support Sentry's default HTML report dialog.
   * Please implement your own UI form to collect user feedback (name, email, comments)
   * and use `Sentry.captureFeedback()` to submit it to Sentry.
   */
  public showReportDialog(_options: ReportDialogOptions = {}): void {
    console.warn(
      '[sentry-miniapp] showReportDialog is deprecated and does nothing. ' +
        'Please build your own UI and use `Sentry.captureFeedback()` instead.',
    );
  }

  /**
   * Capture feedback using the new feedback API.
   * 使用新的反馈 API 捕获反馈
   *
   * @param params Feedback parameters
   * @returns Event ID
   */
  public captureFeedback(
    params: SendFeedbackParams,
    hint?: EventHint & { includeReplay?: boolean },
  ): string {
    const scope = getCurrentScope().clone();
    scope.setClient(this);
    return coreCaptureFeedback(params, hint, scope);
  }
}
