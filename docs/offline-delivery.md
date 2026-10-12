# Offline delivery and Replay ordering / 离线交付与 Replay 顺序

## 中文

默认传输使用一个发送调度器与一个按 DSN 隔离的 Storage 队列。在线且没有积压时直接发送；Replay 等待小程序请求 API 的实际成功响应后才发送下一段，不再为每个健康请求先写入离线缓存。序列化和服务端分类限流仍由固定版本 `@sentry/core` 的基础 transport 处理。

网络失败或 5xx 时入队并退避重试；429 遵守服务端限流，显式 `flush` 也不会越过限流。普通错误继续先尝试发送、失败后持久化。`requireConsent: true` 时，同意前的错误与 Replay 使用同一个 FIFO 队列，授权后先发送积压；撤回同意会在下一次网络调用前生效。已开始的原生请求无法撤销。未启用同意门禁时，`setConsent(false)` 不改变发送行为。

总持久化预算仍默认最多 900 KiB（用户配置只能缩小），未增加第二个缓存。普通离线缓存默认最多 30 条、保留 24 小时；同意门禁继续使用配置的数量、时长与保留最旧策略。内存等待队列最多 64 个等待项，包含进行中请求的总数据最多 2 MiB。超过限制或 Storage 写入失败会记录丢弃并拒绝传输；`Client.sendEnvelope` 会按 core 契约消费传输异常，因此它返回的空对象不等于服务端已接收。

Replay 前段失败时，后段不能越过它。容量或过期淘汰一段时，也清理其已缓存的后续段；调度器拒绝同链后续段。队列过小可能保留首段并拒绝后段，但不会为保后段而淘汰其必需的首段。永久 HTTP 拒绝保留状态码供调用方诊断。core 返回空结果表示本地丢弃，不能当成原生成功响应。

`flush(timeout)` 的返回值覆盖正在发送、等待与持久化积压：截止时间内未清空或仍被同意/限流阻挡时返回 `false`。关闭客户端保留可持久化的待发数据并停止旧调度器；重试使用新的 `sent_at`，不改原事件时间。单个进行中请求在关闭后可能已经被服务端接收，恢复时允许重复发送同一段，以避免无确认的数据丢失。

确认水位只保留在客户端内存中，并限制为 64 个 Replay ID；没有另建持久化确认表。**重启后若缓存从非 0 段开始，无法证明首段曾成功上传，保守丢弃该链**。新 Replay 的第 0 段仍可正常发送。此边界优先防止无首段的残缺回放，不承诺跨重启恢复所有 Replay 后续段。

## English

The default transport uses one sender and one DSN-scoped persistent queue. With no backlog, envelopes are attempted immediately; an online Replay waits for the native request's successful HTTP response before its successor is sent. Healthy Replay segments are no longer forced through offline storage. The pinned core base transport still handles envelope serialization and category rate limits.

Network failures and 5xx responses enter the shared queue with exponential retry backoff. HTTP 429 limits remain authoritative during explicit flushes. Errors retain send-first, persist-on-failure behavior. When consent is required, errors and Replay share the same FIFO; permission is checked again immediately before a native request. Already-started requests cannot be recalled. Disabling consent on a client that did not require it does not block delivery.

The persistent budget remains at most 900 KiB, with the existing count, age and consent eviction policies. There is no separate Replay storage budget. The waiting queue permits at most 64 waiting items, with a 2 MiB total including the active fresh request. Storage failures and capacity rejection record drops and reject transport admission. Core consumes transport rejections in `Client.sendEnvelope`; an empty returned object is not a server acknowledgement.

A failed Replay prefix prevents later segments from overtaking it. Discarding a cached segment also removes dependent cached suffixes, and later dependent sends are refused. A permanent HTTP rejection preserves its status for the caller. An empty result from the core native transport is treated as a local drop, never as a successful HTTP acknowledgement.

`flush(timeout)` covers active requests, waiting items and persistent backlog, returning `false` when the deadline is reached or consent/rate limits still block delivery. Closing stops the old scheduler and retains persistable pending work. Restored requests receive a fresh envelope `sent_at` without changing event timestamps. A request still in flight at close may be retried after restart even if it reached the server.

Acknowledgement progress is held only in memory for up to 64 Replay IDs. **After restart, a stored chain beginning above segment 0 is conservatively discarded because its prefix cannot be proven.** New segment-0 chains remain supported. This avoids uploading orphan recordings and does not promise recovery of every Replay suffix across process restarts.

## Verification / 验证

`test/replay-offline.realcore.test.ts` exercises the actual MiniappClient, core base transport and mocked native request/Storage APIs: consecutive ~490 KB segments, pending native ACK, shared capacity, failure recovery, consent transitions, HTTP limits/rejections, close/reinitialization, storage failures, deadlines and expired data. These are local tests; real DevTools/Sentry delivery is a separate acceptance step.

Implementation reference: [Sentry JavaScript 10.66.0 offline transport](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/core/src/transports/offline.ts) and [base transport](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/core/src/transports/base.ts). The miniapp scheduler replaces the offline wrapper's Replay-first-storage path, while retaining the base transport.
