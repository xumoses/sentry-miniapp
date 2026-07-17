# Experimental Taro DOM Replay recorder

## What this proves

Taro 4.2 maintains a traversable virtual DOM in the logic layer. The opt-in
`startTaroDomReplayPoc` API serializes that tree and its `MutationObserver`
updates into the rrweb event shapes used by Sentry Replay. It also converts
Sentry breadcrumbs into rrweb custom events and network performance spans.

This is an experimental recorder, not a default SDK integration. Native mini
programs and mini games still do not expose a browser DOM and are unaffected.

## Host contract

Call the recorder only after Taro has mounted the current page root (for
example, from `useReady`) and stop it when the page unloads. The host injects
the root and Taro's `MutationObserver`, so `sentry-miniapp` has no runtime Taro
dependency:

```ts
const replay = Sentry.startTaroDomReplayPoc({
  root: document.getElementById(Taro.getCurrentInstance().router?.$taroPath),
  MutationObserver,
  href: 'https://miniapp.local/pages/example',
});

replay.addBreadcrumb({ category: 'ui.click', message: 'button' });
const capture = replay.stop('manual');
```

Applications should normally use a lifecycle adapter such as
`@xumoses/sentry-miniapp-replay-taro` instead of reproducing this wiring. The
adapter injects either the community `sentry-miniapp` namespace or a compatible
fork, subscribes to SDK breadcrumbs, supplies safe platform metadata, and sends
the two-item Replay envelope through the initialized SDK client's
`sendEnvelope` path. That preserves the SDK transport's consent, offline-cache,
and rate-limit behavior; raw DSN uploads are not part of the production path.

## Privacy and resource defaults

- All text nodes and text mutations are masked by default. Set `maskAllText:
  false` only for known synthetic content.
- Input values and common credential/identifier attributes are masked by
  default.
- Capture, network, and DOM-attribute URLs drop query strings, fragments, URL
  user information, and `data:` payloads.
- Request/response bodies and headers are never synthesized by the recorder.
- Recordings remain in memory and stop after 30 seconds, 500 events, or roughly
  512 KiB unless the caller supplies smaller limits.
- Replay IDs are UUIDv4 values and byte limits count UTF-8 bytes.

The low-level API accepts metadata for envelope construction, so direct users
remain responsible for removing personal data from custom metadata and generic
breadcrumb fields. The standalone adapter discards `metadata.user` by default
and filters common sensitive breadcrumb keys before they reach the recorder.

## Current compatibility boundary

The verified path is Taro 4.2 + React on WeChat. The experiment does not claim
support for native mini-program page trees, Canvas, WebView, native components,
pixel-perfect WXSS reconstruction, multi-page stitching, buffered error Replay,
sampling, persistent segment queues, or every supported mini-program platform.

Before widening support, validate each platform with feature detection and a
safe no-op fallback, then test playback plus the Breadcrumbs, Network, Tags,
and Contexts panels in a non-production Sentry project.
