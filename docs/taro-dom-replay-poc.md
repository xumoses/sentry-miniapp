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

## Official baseline and supported event surfaces

The reference is [Sentry JavaScript 10.66.0 Replay configuration](https://github.com/getsentry/sentry-javascript/blob/10.66.0/packages/replay-internal/src/integration.ts),
matching this SDK's `@sentry/core` version. The recorder uses the
[rrweb event schema](https://github.com/rrweb-io/rrweb/blob/main/packages/types/src/index.ts)
for mutations, Input (source 5), MouseInteraction (source 2), Scroll (source 3),
ViewportResize (source 4), and TouchMove (source 6). This is a mini-program
implementation of available surfaces, not an installation of the browser recorder.

When the mounted root offers event listeners, bubbling native `input`/`change`
events for Input and Textarea are captured even without a MutationObserver update.
Controlled value updates are also emitted as Input events so an already edited
playback control receives the new property value. Values share the snapshot masking
rules; native input observation never writes application props. A weak cache keeps
the latest observed value on the same mounted node across recorder restart.
Taps, touch start/end/cancel and focus/blur reference recorded node IDs. Taps add a
`ui.click` breadcrumb with only the node kind and ID, never its label or input value.
Touch movement uses actual coordinates at most every 50 ms. Pointer events lacking
coordinates are omitted; focus/blur need none. Native events stopped before reaching
the root are not intercepted or re-dispatched. Unsupported listener APIs safely skip
this layer, while DOM mutation recording remains available.

The lifecycle adapter may call `recordPageScroll({scrollTop, scrollLeft})` from
Taro `onPageScroll`, and `recordViewport({width, height})` from `onResize`.
Invalid values and unchanged positions/sizes are ignored. Page scroll uses document
ID 1 and becomes `initialOffset` in checkpoints and rolling rebases; viewport changes
update rrweb dimensions and recompute rpx layout. Without those lifecycle inputs the
recorder cannot infer native window scrolling or orientation changes.

`takeSegment()` drains a session segment while keeping the observer, native listeners,
node IDs and privacy state attached. The first segment contains Meta + FullSnapshot;
subsequent segments may contain increments only and must be sent in order with the same
Replay ID. It does not reset the recorder's duration limit. A stopped recorder returns
its terminal capture, and a rolling error buffer returns a copy without draining, so
periodic flush cannot destroy the error-before context. `getCapture`, `takeSegment`
and `onEvent` expose detached data; modifying it cannot corrupt retained events or
their cached byte accounting.

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
`width / 750` (375 px when width is omitted). Trusted build CSS strings, comments,
and asset URLs remain intact. Runtime inline/control style strings remove comments
and sanitize URL tokens (including CSS escapes and image-set string URLs); with
`blockAllMedia` enabled their dynamic URLs are blanked. Native views keep content-box sizing, so a 44 px navigation view
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
Checkpoints inside the current window remain in the tail when they fit the caps:
opening a modal does not discard the action that opened it. Meta and its following
page snapshot advance together when eviction crosses a navigation boundary. Input
values and native page scroll offsets are folded along with DOM/ScrollView changes.
Immutable event byte counts are cached, so each scroll event does not reserialize
the unchanged static stylesheet or image-heavy baseline. Removed virtual node IDs
and native listeners are released; a mutation batch exceeding `mutationLimit`
(10,000 by default, following the official Replay default) stops with
`mutation-limit` before serializing the batch.

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
content. Native page/window scrolling additionally requires the lifecycle adapter's
explicit `recordPageScroll` bridge described above; component internals remain outside
the current recording boundary.

The host-app Replay POC fixture measured in WeChat DevTools on
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
browser-compatible detection does not normalize whitelist keys. Non-whitelisted
URLs remove browser-ignored C0/ASCII whitespace, query/fragment and user information,
including protocol-relative URLs. The SDK does not read platform files or fetch assets.

## Explicit Canvas frames

Canvas recording is disabled by default. Set `recordCanvas: true` and put
`data-sentry-canvas={true}` on each audited `canvas` or `view` container to opt in.
Only that marked node is eligible; the marker does not grant permission to its
descendants. Give the container an explicit rendered width and height in its
layout styles. The recorder preserves those attributes on a `div` and reserves
one stable synthetic `img` child before the first frame arrives. Its original
children and their mutations, input, scrolling and pointer events are excluded.
The virtual application tree and native chart remain unchanged.

After a chart finishes drawing, the host supplies a synchronous lazy reader:

```ts
replay.recordCanvas(markedVirtualNode, () => nativeCanvas.toDataURL('image/png'));
```

The host owns native Canvas discovery, readiness and export APIs. The SDK never
enumerates native canvases, exports the screen, reads platform files, or intercepts
drawing commands. Native APIs which export asynchronously must first prepare a
frame and then pass a reader for the prepared value, with their own current-page
and privacy guards before native export. Use the chart's completed-render callback
and a trailing throttle when needed to retain its final state. Missing APIs or an
unavailable frame can return `undefined`; that keeps the previous frame.

Before invoking the reader, the SDK checks the recorder's opt-in, marker, actual
parent/child membership in its current root, previously serialized node identity,
and every ancestor's `data-sentry-mask`, `data-sentry-block`, `data-sentry-ignore`
or corresponding class. Protected, detached, replaced or stopped recorders cannot
read pixels. The lifecycle adapter must stop/detach on page hide; the SDK cannot
infer native page visibility. It rechecks membership and privacy after the reader
returns. Marker revocation, subtree removal and explicit protection discard retained
frame state; lifting protection never restores an earlier frame. Reader and
event-callback exceptions cannot interrupt the chart render through this method.

This explicit permission allows the selected pixels despite `blockAllMedia: true`;
ordinary media retains its existing filtering. **Pixels cannot be text-masked**,
including when `maskAllText` or `maskAllInputs` is enabled. Audit all chart labels,
tooltips and surrounding content before opting in. This follows the official
[Sentry Canvas opt-in and pixel privacy boundary](https://github.com/getsentry/sentry-docs/blob/master/docs/platforms/javascript/common/session-replay/index.mdx#canvas-recording).
It is a static-frame mini-program bridge, not the browser Canvas recorder.

The reader is attempted at most once per second per live node, including failures.
Only canonical base64 PNG, JPEG or WebP data URIs with matching raster signatures
are accepted, with a 128 KiB limit on the complete URI. This validates encoding
and file signatures, not the meaning or privacy of the pixels. Identical frames
are deduplicated. Retained frame URIs across all nodes are capped at the smaller
of 128 KiB and one quarter of `maxBytes`. Before accepting a changed frame, the
recorder also checks current segment bytes/events and the next complete checkpoint
using only already committed rrweb state. Budget exhaustion returns `false`, records
a bounded diagnostic, keeps the previous frame and leaves normal Replay running.
An optional bounded checkpoint mirror supports this check across drained segments;
it is released on stop. A subsequent normal checkpoint can re-enable Canvas after
an oversized DOM state made its mirror ineligible. These limits do not change the
recorder's normal duration or mutation limits.

Frames use ordinary rrweb source-0 `img.src` attribute increments, and the last
accepted image is retained in full snapshots, session segments and rolling rebases.
This avoids relying on a dynamic `rr_dataURL` canvas attribute: rrweb's
[snapshot rebuild](https://github.com/rrweb-io/rrweb/blob/master/packages/rrweb-snapshot/src/rebuild.ts)
draws that attribute at rebuild time, whereas the ordinary
[attribute replay path](https://github.com/rrweb-io/rrweb/blob/master/packages/rrweb/src/replay/index.ts)
supports live `img.src` updates. No continuous video or drawing-command equivalence
is claimed. WeChat API availability must be feature-detected; the official
[mini-program API declarations](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)
describe `Canvas.toDataURL`, `canvasToTempFilePath` and filesystem reads.

Local release verification runs `yarn build`, which first replaces `dist` with the
minified ESM/CJS outputs and then appends the UMD output. Vite 6's UMD helper
injection interprets replacement-string tokens in minified identifiers; this
separate UMD pass disables identifier minification while retaining syntax and
whitespace compression. The mini-program CJS output keeps full minification.
The build parses all three actual bundles, executes the browser UMD exports,
then synchronizes the example and verifies portable source maps. Direct
`vite build`, `build:types` and `dev` continue emitting all formats with safe UMD
settings; `build:miniapp` retains its separate CommonJS example build.

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
- `maskAllInputs` is the official spelling and overrides the compatible
  `maskInputValues` spelling when both are supplied. `blockAllMedia` defaults to
  true: untrusted runtime Image/img sources, native media and WebView resource URLs
  (including video posters), and CSS image URLs are withheld. This applies even
  when an unsupported native component is represented only by a placeholder. Audited
  `staticImageSources` entries remain an explicit per-image opt-in; packaged Home
  icons do not need a global media opt-out. `data-sentry-unblock`/`sentry-unblock`
  or `blockAllMedia: false` permits dynamic media URLs, still with URL scrubbing.
- As in the official configuration, `maskAttributes` defaults to `title`,
  `placeholder`, and `aria-label`, independently of the global text opt-out.
  `data-sentry-mask`/`sentry-mask` on an ancestor forces descendant text, display
  attributes and input values to remain masked. `data-sentry-unmask`/`sentry-unmask`
  permits ordinary text/attributes, but does not override an explicit mask or a
  password's sticky protection. `data-sentry-block`/`sentry-block` records an empty
  placeholder without subtree content or attributes; its DOM/native updates are
  ignored until unblocked. `data-sentry-ignore`/`sentry-ignore` suppresses native
  interaction/input events. Arbitrary browser CSS selectors are not evaluated.
- Common credential/identifier attributes stay filtered independently of the
  text/input masking settings.
- Capture, network, and DOM-attribute URLs drop query strings, fragments, URL
  user information, and `data:` payloads.
- Request/response bodies and headers are never synthesized by the recorder.
- Normal recordings remain in memory and stop after 30 seconds, 500 events, or
  roughly 512 KiB unless the caller supplies different limits. Error-buffer
  callers can set `rollingWindowMs`; this rolls by time/event/bytes while
  preserving the Meta + FullSnapshot checkpoint.
- Non-finite numeric limits fall back to these defaults. Finite limits are
  rounded down and bounded: duration 1 ms–1 hour, event count 1–100,000, bytes
  1–20 MiB, mutation batch 1–100,000, and rolling history 0–60 seconds (30 seconds
  for an invalid configured window). These ceilings keep a misconfigured caller
  from disabling the recorder's memory and duration safeguards.
- Replay IDs are UUIDv4 values and byte limits count UTF-8 bytes.

The low-level API accepts metadata for envelope construction, so direct users
remain responsible for removing personal data from custom metadata and generic
breadcrumb fields. The standalone adapter discards `metadata.user` by default
and filters common sensitive breadcrumb keys before they reach the recorder.

## Current compatibility boundary

The supported recorder path is Taro 4.2 + React on WeChat. The 2026-10-11 extensions
above have local regression evidence; device and actual Sentry Playback acceptance
remain separate release gates. Native page trees, unmarked Canvas pixels, WebView documents,
native component internals, browser selection ranges and pixel-perfect WXSS or native
theme reconstruction are not exposed by this virtual DOM and are not synthesized.
The adapter owns session sampling, error promotion, navigation stitching, ordered
delivery and lifecycle hooks. Browser-only facilities such as CSSOM observers,
cross-origin iframe access, web-vitals and dead/rage-click detection are not implied
by emitting compatible rrweb events. There is no claim of every mini-program platform
or arbitrary DOM-selector support.

Before widening support, validate each platform with feature detection and a
safe no-op fallback, then test playback plus the Breadcrumbs, Network, Tags,
and Contexts panels in a non-production Sentry project.
