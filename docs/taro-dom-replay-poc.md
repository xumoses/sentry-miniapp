# Experimental Taro DOM Replay recorder

## Production phase-one contract

The native mini-program entry remains the only Sentry client. The SDK accepts
`replaysSessionSampleRate` and `replaysOnErrorSampleRate` for the external
Replay configuration contract. Its public `beforeSendEvent` callback runs only
after event processors, `beforeSend`, and error sampling accepted an event and
immediately before the event envelope is built, so an adapter can add
`replay_id` without using private client fields.

The separate adapter owns the logical-session sampling decision, bounded
rolling buffer, error promotion, Replay envelope association, and Taro root
attach/detach. This file describes the low-level recorder it uses.

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
  width: 390,
  stylesheet: replayStylesheet, // Trusted CSS prepared by the application's build.
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

## Playback styles

The recorder accepts an optional `stylesheet` containing trusted static CSS
prepared by the host build. It appends that CSS after the mini-program control
defaults in every FullSnapshot, including structural checkpoints. The host must
include the relevant application/page styles and convert WXSS component selectors
to the serialized `data-taro-node` selectors; the SDK does not read files or fetch
stylesheets at runtime. Do not put input values, user data, or runtime URLs in this
stylesheet: it is trusted code and does not pass through text or attribute masking.

Both this CSS and inline snapshot/mutation styles convert `rpx` lengths with
`width / 750` (375 px when width is omitted). CSS strings, comments, and asset URLs
remain intact. Native views keep content-box sizing, so a 44 px navigation view
with 47 px top padding remains 91 px tall. Default buttons use block layout,
mini-program font/line-height and border styling; inputs, textareas, and vertical
scroll views have corresponding browser defaults. Caller CSS may override these
defaults. This improves the recorded layout without claiming full native component
or platform theme equivalence. Stylesheet bytes count toward the existing capture
limits.

When a rolling buffer cannot fit both the previous checkpoint and a newly
recorded complete snapshot, it retains the new snapshot with an aligned Meta
event and discards the earlier DOM history already represented by that snapshot.
The Replay ID remains unchanged, and later mutations refer to the new checkpoint.
When time, event count or bytes evict older DOM/scroll increments, their changes
are folded into a cloned baseline before retaining the recent tail. This keeps
long-lived forms and filtered lists current after the original changes age out.
The input events are not mutated, Meta precedes its rebased snapshot, and a
complete checkpoint that cannot fit the cap stops recording, preserving the
previous compliant event array and statistics rather than retaining the rejected
oversized increment.
If even one complete checkpoint exceeds the configured cap, recording stops
without installing a new observer rather than retaining an oversized payload.

## Scroll-view recording

When a Taro `scroll-view` node exposes both `addEventListener` and
`removeEventListener`, the recorder appends its own `scroll` listener. Native
`detail.scrollLeft` and `detail.scrollTop` become rrweb
[Scroll events (`id`, `x`, `y`)](https://github.com/rrweb-io/rrweb/blob/main/packages/types/src/index.ts).
Unchanged offsets are deduplicated, invalid or negative coordinates are ignored,
and these events use the existing recording limits. Application scroll handlers
continue to run, and recorder listeners are removed on subtree removal and stop.
Nodes without these APIs safely skip scroll-event recording.

FullSnapshots retain the current offsets using rrweb's
[`rr_scrollTop` and `rr_scrollLeft` attributes](https://github.com/rrweb-io/rrweb/blob/main/packages/rrweb-snapshot/src/snapshot.ts),
including structural checkpoints. A weak cache keyed by the live virtual node
preserves observed native offsets when error promotion restarts the recorder on
the same mounted page. Before any scroll event, controlled numeric `scrollTop`
and `scrollLeft` props supply the initial position. This covers Taro ScrollView
content; native page/window scrolling and other component internals remain outside
the current recording boundary.

The derivative-manager Replay POC fixture measured in WeChat DevTools on
2026-10-09 uses a native input font size of 12 px and a warn-button background of
`rgb(230, 67, 64)` (`#e64340`). The corresponding defaults above follow that live
fixture; other platform/theme defaults still require their own validation.
The base text line-height is 1.4 to approximate its observed native line boxes.
Its font family uses `-apple-system`, `BlinkMacSystemFont`, and `Segoe UI` before
the sans-serif fallback to approximate the native system-font widths and wrapping.
Literal `font-size` declarations in `rpx` floor the scaled pixel value (34 rpx
becomes 17 px at a 390 px viewport); other lengths retain fractional scaling.
Expressions and custom properties keep the existing conversion without this
font-specific rounding, and CSS strings, comments, and URLs remain unchanged.
Normal buttons use [stretch sizing](https://www.w3.org/TR/css-sizing-3/) so their
margin box fills the parent without overflowing when horizontal margins are set.
The CSS retains `100%` and `-webkit-fill-available` fallbacks; mini buttons keep
their intrinsic `auto` width.

## RootPortal and PickerView browser semantics

Enabled `root-portal` subtrees are lifted to the synthetic document body, as the
native component detaches its subtree from page layout. Disabled portals retain
their original position. Portal insertion/removal and `enable` changes create a
complete checkpoint so rrweb never retains a portal under a removed ancestor.
The virtual Taro tree itself is not changed. Ancestor-dependent CSS selectors or
custom properties still need host/platform validation after this browser mapping.

`picker-view` retains all original column and option nodes. Browser styles center
the selected row in each column using `value` or `defaultValue`, native indicator
height, and per-row offsets. Native `change.detail.value` events update column
selection without replacing or blocking application handlers. Observed selection
survives recorder restart on the same live node; controlled prop changes and row
structural changes create a checkpoint. Hosts without event-listener APIs retain
the initial selection only. This models the native wheel's rows and selected
positions; native inertial animation and platform-specific indicator/mask themes
are outside this approximation.

## Audited static image sources

The optional `staticImageSources: Readonly<Record<string, string>>` maps an exact
native image `src` to a trusted build-generated image data URI. It enables
packaged logos and source-code inline icons to render independently of the miniapp
filesystem. Acceptable raster values are base64 PNG, JPEG, GIF, WebP, or AVIF.
Static SVG values may use either of these forms (the UTF-8 charset is optional):

- `data:image/svg+xml[;charset=utf-8];base64,<standard padded base64>`
- `data:image/svg+xml[;charset=utf-8],<URI-encoded UTF-8 SVG>`

Both the FullSnapshot and later `src` mutations retain the complete trusted URI,
including its original encoding. Percent encoding must decode as valid UTF-8;
raw XML, malformed encodings, unsupported MIME types and entries above 128 KiB
per complete URI fall back to the normal filtered URL behavior. The original
native `src` remains the exact lookup key, including a Taro inline data URI when
applicable. A host may map that original key to canonical base64 from the same
reviewed source asset. Each actual use counts toward recorder byte limits; the
host must also bound the total mapping for each route.

This is an explicit code/asset trust boundary, not an SVG content sanitizer. The
SDK validates URI encoding and size, without parsing XML or removing scripts,
event handlers, external references or `foreignObject` contents. The host must
audit its build inputs and only include static images safe to display in Replay.
Never populate the map from runtime user photos, generated user content, temporary
files or downloaded image data. Only explicit own properties are used, only for
Taro Image `src`; unlisted or changed runtime SVG/data URLs retain the existing
payload removal, including mixed-case `Data:` / `DATA:` schemes, leading C0
control characters/spaces, and ASCII tabs or newlines within the scheme. That
browser-compatible detection does not normalize whitelist keys or rewrite
non-data URL content. The SDK does not read platform files or fetch assets.

## Privacy and resource defaults

- All text nodes and text mutations are masked by default. Set `maskAllText:
false` only for known synthetic content.
- Ordinary input values are masked by default. With `maskInputValues: false`,
  ordinary input values remain visible while password values always stay masked.
  Password fields are detected from Taro `password: true`, HTML `type: "password"`,
  or an explicit `data-sentry-mask="true"` attribute on the input or an ancestor.
  Keep that explicit marker on login inputs even when their password reveal toggle
  is already enabled when recording starts. Once identified, an input stays masked
  through value mutations and password/type changes. Sensitivity follows the same
  mounted input object across recorder restarts, error-buffer promotion and page
  reattachment, and is retained weakly until that input is released. Changing an
  ancestor marker checkpoints descendant values with their current privacy rules.
  New input objects do not inherit a reused `sid`; keep the explicit marker on
  password fields and their replacements when they may mount in the revealed state.
- Common credential/identifier attributes stay filtered independently of the
  text/input masking settings.
- Capture, network, and DOM-attribute URLs drop query strings, fragments, URL
  user information, and `data:` payloads.
- Request/response bodies and headers are never synthesized by the recorder.
- Normal recordings remain in memory and stop after 30 seconds, 500 events, or
  roughly 512 KiB unless the caller supplies different limits. Error-buffer
  callers can set `rollingWindowMs`; this rolls by time/event/bytes while
  preserving the Meta + FullSnapshot checkpoint.
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
