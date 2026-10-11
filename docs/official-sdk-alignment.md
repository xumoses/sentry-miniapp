# Sentry 官方能力对齐与小程序边界

核对日期：2026-10-11。实现基准为锁定的 `@sentry/core@10.66.0`、本库源码和本地真实 core envelope 测试；未升级 core、未发布 npm，未把本地验证表述为 Sentry 服务端或真机验收。官方文档会滚动更新，因此涉及默认值及协议时以固定版本源码为准。

## 依据

- [Sentry JavaScript 配置](https://docs.sentry.io/platforms/javascript/configuration/options/)：采样、初始 scope、过滤钩子、日志、指标、传输与 client reports。
- [Sentry SDK 开发规范](https://develop.sentry.dev/sdk/)与 [Contexts schema](https://develop.sentry.dev/sdk/foundations/envelopes/event-payloads/contexts/)：SDK 协议和字段含义。
- 固定版本 [core Client](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/core/src/client.ts)、[event builder](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/core/src/utils/eventbuilder.ts)、[integration resolution](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/core/src/integration.ts)、[offline transport](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/core/src/transports/offline.ts)；与本机安装的 `build/cjs` 实现交叉核对。
- 固定版本 [idle spans](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/core/src/tracing/idleSpan.ts)、[span streaming](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/core/src/integrations/spanStreaming.ts)、[feedback](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/core/src/feedback.ts)、[logs](https://github.com/getsentry/sentry-javascript/tree/10.66.0/packages/core/src/logs)、[metrics](https://github.com/getsentry/sentry-javascript/tree/10.66.0/packages/core/src/metrics)。

## 适用能力矩阵

| 能力 | 本库实现和验证 | 开关与边界 |
| --- | --- | --- |
| 错误、消息、任意 JS 异常值 | `captureException/captureMessage/captureEvent` 走 core builder 和完整处理链；null、undefined、数值、对象均有可分组事件，Error cause/aggregate 使用实际 stackParser；指纹去重逐项比较，避免拼接碰撞 | GlobalHandlers 接平台支持的错误/rejection API；TryCatch 包装平台存在的计时器；不依赖 window |
| 初始上下文、scopes、事件处理 | `initialScope`、`Scope`、current/isolation/global scopes、withScope/withIsolationScope、tags/user/context/attributes、event processors、beforeSend、beforeSendTransaction 沿 core 实现；真实 envelope 验证 build tag/dist | 与浏览器的 stack scope 模型一致，不提供 Node AsyncLocalStorage；跨独立异步业务链通过 `withActiveSpan` 等显式绑定，不能承诺任意 Promise 自动隔离 |
| Session / Release Health | App launch/show 开始、hide/close 结束；未处理异常由 core 更新 session；公开 start/end/captureSession | 需要 release 和平台生命周期 API；小游戏使用独立兼容集成；session 无服务端 release 数据仍需部署验收 |
| 页面及 HTTP tracing | 新 PageTracing 覆盖通过原生 Page 注册的 Taro 页面：pageload/navigation idle root，onReady 后允许 idle 结束，hide/unload/close 结束；HTTP 子 span、callback 中错误保持同 trace；原业务 this/参数/返回值/异常保留 | 需配置 tracesSampleRate 或 tracesSampler；enablePageTracing:false 关闭；无 Page 的平台安全跳过；不是浏览器 FCP/LCP/Web Vitals |
| 手动 tracing / 采样 | startSpan/startSpanManual/startInactiveSpan/continueTrace/startNewTrace/withActiveSpan/suppressTracing/getTraceData 等为真实 core API；custom sampler 已验证；10.66 默认 static，显式 stream 自动加入 SpanStreaming，beforeSendSpan 用 withStreamedSpan | `defaultIntegrations:false` 时使用 stream 需显式提供 spanStreamingIntegration；服务端 stream 接收能力需单独验证 |
| 分布式 trace | HTTP sentry-trace/baggage 注入；保留大小写不同的已有 headers；调用者 options 不被修改；exact tunnel 排除 | tracePropagationTargets 未配置保留旧版广泛注入行为；显式 [] 禁止，推荐完整可信 origin 的锚定正则；服务端须接受这些 headers 才能串联 |
| Logs / Metrics | logger 与 metrics count/gauge/distribution、scope attributes、beforeSendLog/beforeSendMetric、flush 输出真实 log/trace_metric envelopes，非空壳 API | 10.66 logs 需 enableLogs:true；metrics 由 enableMetrics 控制；只因业务显式调用产生数据，无默认 console 抓取，consoleLoggingIntegration 可明确选择 |
| 用户反馈 / 附件 | captureFeedback 使用 core feedback 路径、beforeSendFeedback hook、hint attachments 和 includeReplay；scope/tag/associatedEventId 保留；附件可为字符串或 Uint8Array | 自行提供小程序 UI；无 HTML 反馈浮层/自动截图；姓名/邮箱由业务显式提供和审核；Replay 关联由适配器实现 |
| 传输 / 限流 / client reports | 自定义 transportOptions.headers 生效；微信 binary body 转 ArrayBuffer；响应 header 归一化后沿 core rate limit；默认 sendClientReports:true，flush 通过同一受限 transport 发送 outcomes | client_report 不进入 core 离线队列；回调钩子、tunnel 和禁用状态沿 core 管线；自定义 transport 需自己正确实现实际网络限流 |
| 离线 / consent / 重初始化 | envelope 附件 bytes 持久化后完整恢复；按 DSN 隔离存储；数量/年龄/字节上限；每个 client 独立 consent gate；close 停止后续队列重试并同步撤销自身 instrumentation，旧 close 异步完成不拆新 wrapper | requireConsent 缓存是明确选择的本地收集，非停止收集；禁用客户端不重放缓存；旧无 DSN 命名空间缓存不迁移，避免发错项目；flush 返回不保证离线队列已送达，close 保留未发送缓存 |
| 设备与应用信息 | os.name/os.version 从系统字符串分离，app.app_version 取小程序版本，miniapp_host 独立保存微信版本/基础库版本；用户设置的 context 优先；缺失平台 API guarded | enableSystemInfo:false 不自动补系统数据；不将微信版本误当 OS，不将基础库版本误当业务 app version |
| Taro Replay | opt-in Taro 节点采集、遮罩、CSS/URL 防泄露、网络/错误关联、缓冲/分段、手动输入和滚动等详见 [Replay 文档](./taro-dom-replay-poc.md) | 不以 rrweb 浏览器 DOM 录制器替代小程序适配器；自定义组件和原生输入/scroll 需要框架事件接入 |
| Sourcemap / Release | RewriteFrames、release/dist、外部上传路径沿现有实现；宿主上传流水线负责实际 artifacts | 本地 stack frame 格式正确不等于部署后的 sourcemap 符号化已验收 |
| 平台性能 / 小游戏 | 保留 guarded performance APIs、平台实际提供的导航/渲染/资源、自定义 mark，以及小游戏帧率/启动测量 | 仅采集平台真实数据；不补造浏览器 Web Vitals、JS CPU profiler、Session Replay 视频或 DOM widget |

## 默认与兼容注意事项

`MiniappOptions` 承接 core 10.66 的适用配置类型，保留本库扩展。`integrations` 数组按官方规则追加并按名称覆盖，函数接收完整的平台默认集合；`defaultIntegrations:false` 禁用全部默认集成。需要网络/页面自动采集时不要禁用默认集合，或显式加回对应 integration。

默认不收集 request/response body、onLoad query 值、事件 dataset、计时器异常实参。`sendDefaultPii:true` 才允许后面三类字段；request/response body 另需 `traceNetworkBody` 明确开启。URL query/hash 默认不写入 HTTP breadcrumb/span；tracePropagationTargets 只控制 trace header，不构成数据脱敏规则。业务自己传入 user、extra、feedback、attachment、logger/metrics 属性仍需自行限定内容及配置相应 beforeSend 钩子。

初始化应在 App/Page 注册之前完成。重复 init 会同步撤销旧的 owned wrappers 后装配新客户端；已有页面注册对象及已排队业务回调不是可撤回资源。Node 式多个同时活动的全局 instrumentation clients 不是此小程序 SDK 的运行模型；每个 client 的 consent/transport 状态仍独立。

App hide 触发有时限的 best-effort flush。进程被平台立即挂起时无法保证网络完成；缓存和下一次启动重试只在容量及保留时间内生效。服务端限额、滥用保护及 4xx 拒绝也不能用本地缓存承诺“零丢失”。

## 本地验收

`test/official-capabilities.realcore.test.ts` 使用实际 core 和收集 envelope 的本地 transport，覆盖初始 scope/任意异常值/cause/附件、log/metric hooks、feedback、Page→HTTP→error、目标域规则、binary 离线往返、双 client consent、关闭重试、限流、stream span/custom sampler、disabled 全信号、延迟 reinit 和平台 metadata。其余原有 suites 覆盖七端兼容、Session、全局错误、性能及 Replay。

执行 `npm run lint`、`npm run typecheck`、`npm test -- --runInBand`、`npm run build`。实际执行结果以本次任务记录为准。npm 发布后的宿主体验版还需验证真实 Issue/Replay/sourcemap、trace parent/child、附件/log/metric 服务端接收及 consent/后台恢复行为；未触发发布或线上写入。
