# PROTOTYPE — Taro DOM Replay

## Question

Can Taro 4.2's in-memory DOM and `MutationObserver` produce the rrweb FullSnapshot, Mutation, Breadcrumb, and network performance events required for local playback and useful Sentry Replay ingestion without a browser DOM?

## Boundaries

- Explicit opt-in through `startTaroDomReplayPoc`; it is not a default integration.
- The host passes the mounted Taro root and Taro's `MutationObserver`, so the SDK does not depend on Taro and other mini program platforms are unaffected.
- State is held in memory for at most 30 seconds, 500 events, or approximately 512 KB.
- Input values are masked by default.
- `addBreadcrumb` converts interaction and navigation breadcrumbs to Sentry-compatible rrweb Custom Events. `xhr` and `fetch` breadcrumbs become `performanceSpan` events so Sentry's Network panel can display URL, method, status, duration, and optional byte counts.
- The host may attach Replay event metadata (`environment`, `release`, SDK identity, anonymous user, tags, and contexts). The `derivative-manager` POC uses this for Taro/WeChat versions and the active route.
- Replay URLs use the synthetic HTTPS origin `https://miniapp.local`; custom mini program schemes are not accepted because Sentry renders them as `null:///...`.
- Network request/response bodies and headers are not copied into the POC recording. The host-provided user ID must be anonymous or otherwise privacy-safe.
- Native components, Canvas, WebView, WXSS conversion, sampling, persistence, and production privacy controls are outside this prototype.

## Local package verification

From the `derivative-manager` POC branch:

```bash
SENTRY_MINIAPP_DIR=/Users/moxu/dev/personal/sentry-miniapp npm run poc:sentry-local
```

The command builds this checkout, verifies the `npm pack` file list, installs the tarball without saving its temporary path, generates `miniprogram_npm/sentry-miniapp/index.js`, checks the POC marker, and starts the local rrweb viewer at `http://127.0.0.1:4318`.

The command intentionally does not build the host Taro project. After a developer runs `cd taro-project && npm run build` in `derivative-manager`, import that repository root in WeChat DevTools and open `/taroMiniapp/pages/ReplayPoc/index`. Exercise a mutation button, the test network request, and the stop/upload button. In Sentry, verify playback plus the Breadcrumbs, Network, and Tags panels before deleting or promoting any prototype code.
