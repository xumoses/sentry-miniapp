# Runtime contexts shared by errors and Replay

`MiniappClient.getRuntimeContexts(): PromiseLike<MiniappRuntimeContexts>` provides
pure technical defaults. The Taro Replay adapter can await this method before
sending a capture so error events and Replay use the same source and cache.
It returns a fresh copy, contains no scope user, app ID or account identity, and
does not copy caller contexts. Explicit event/scope context fields override SDK
defaults; explicit event `null` suppresses a context. The optional deprecated
`System` integration also uses
this provider rather than writing independent system guesses into global scope.

| Context | Source and meaning |
| --- | --- |
| `os` | Real devices use the miniapp device API's system name/version. WeChat DevTools uses verified host information as described below. |
| `device` | Physical device fields from miniapp APIs; `device.simulator: true` marks DevTools. An emulated iPhone model never becomes the development computer's model. |
| `browser` | `WeChat` with the native host version, or `WeChat DevTools` with the tool version. This identifies the host, not a WebView engine. Other miniapp hosts do not receive an invented browser context. |
| `miniapp_host` | Miniapp host name/version and the separate `sdk_version` base-library version. DevTools host version comes from its verified `wechatdevtools/x` token. |
| `runtime` | `miniapp`; `version` is the base-library `SDKVersion`, never the WeChat application version. |
| `app.app_version` | The miniapp's own version, when available. |
| `miniapp_simulator` | DevTools-only emulated system, model, brand, platform, screen resolution and simulated WeChat version. These values do not describe the development computer. |

Normal iOS, Android and desktop WeChat clients only use miniapp APIs. They do not
read `navigator`. The modern base/device/window APIs are guarded independently;
a failing API cannot erase another one's valid fields. A legacy system API may
fill missing identity fields. Host `version` is never substituted for a missing
`SDKVersion`, and no host version is written into `device.version` or OS
`kernel_version`.

When the miniapp platform explicitly reports `devtools`, emulated phone fields
are separated first. On every platform, missing physical hardware identifiers
are omitted rather than sent as the literal `unknown`: Sentry Relay's device catalog contains an
Android model named `unknown` and can normalize it to Motorola Defy even for a
simulator. See the [Relay 24.11 catalog](https://github.com/getsentry/relay/blob/24.11.0/relay-event-normalization/src/normalize/android_models.csv)
and [model-based normalization](https://github.com/getsentry/relay/blob/24.11.0/relay-event-normalization/src/normalize/contexts.rs).
Only WeChat DevTools with a recognized `wechatdevtools/x`
user-agent token may additionally inspect browser Client Hints. One guarded
`userAgentData.getHighEntropyValues` call requests platform version, architecture
and bitness; it has a 200 ms deadline shared by concurrent consumers. Valid macOS
platform versions are used as host OS versions. Windows Client Hints report an
API contract version, so this implementation conservatively reports `Windows`
without presenting that number as a Windows marketing/kernel version.

Missing, rejected, malformed or timed-out hints never reject the event. A known
host platform may still supply the OS name, but no version is guessed from the
simulated iPhone user agent or frozen/reduced OS version strings. Unverified
DevTools environments keep the host OS unknown. Successful device discovery and
its hint fallback are cached per client; late hint completion cannot change a
previous result. If system APIs were not ready and no device identity was found,
the next event retries discovery. Reinitializing the client owns a new hint cache.
`enableSystemInfo: false` returns empty defaults and skips system, account-version
and navigator collection in this path.

This is a guarded miniapp implementation, not an official Sentry 10.66.0
`clientHintsIntegration` (that integration is not present in the pinned SDK).
The source contracts are the [WeChat device API](https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getDeviceInfo.html),
[WeChat base information API](https://developers.weixin.qq.com/miniprogram/dev/api/base/system/wx.getAppBaseInfo.html),
[Chrome Client Hints documentation](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints)
and [Microsoft's Windows version guidance](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/how-to-detect-win11).
Local tests exercise the actual core envelope pipeline, timeout/failure behavior,
physical-device paths and default/override isolation. Real DevTools and remote
Sentry acceptance are separate validation steps.
