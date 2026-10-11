/** Browser equivalents for the native controls used by the Taro recorder. */
export const TARO_REPLAY_BASE_STYLESHEET = [
  'html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.4}',
  '[data-taro-node="view"],[data-taro-node="root"]{display:block}',
  '[data-taro-node="button"]{position:relative;display:block;width:100%;width:-webkit-fill-available;width:stretch;margin-left:auto;margin-right:auto;padding:0 14px;box-sizing:border-box;font-family:serif;font-size:18px;text-align:center;text-decoration:none;line-height:2.55555556;border:0;border-radius:5px;overflow:hidden;color:#000;background:#f8f8f8}',
  '[data-taro-node="button"]::after{content:" ";position:absolute;top:0;left:0;width:200%;height:200%;box-sizing:border-box;border:1px solid rgba(0,0,0,.2);border-radius:10px;transform:scale(.5);transform-origin:0 0;pointer-events:none}',
  '[data-taro-node="button"][size="mini"]{display:inline-block;width:auto;padding:0 1.34em;font-size:13px;line-height:2.3}',
  '[data-taro-node="button"][type="primary"]{color:#fff;background:#07c160}',
  '[data-taro-node="button"][type="warn"]{color:#fff;background:#e64340}',
  '[data-taro-node="button"][disabled]{color:rgba(0,0,0,.3);background:#f7f7f7}',
  '[data-taro-node="button"][type="primary"][disabled]{color:rgba(255,255,255,.6);background:#9ed99d}',
  '[data-taro-node="button"][type="warn"][disabled]{color:rgba(255,255,255,.6);background:#f6baba}',
  '[data-taro-node="button"][plain]{color:#353535;background:transparent;border:1px solid #353535}',
  '[data-taro-node="button"][plain]::after{border:0}',
  '[data-taro-node="button"][plain][type="primary"]{color:#07c160;border-color:#07c160}',
  '[data-taro-node="button"][plain][type="warn"]{color:#e64340;border-color:#e64340}',
  '[data-taro-node="input"]{display:block;width:100%;height:auto;min-height:1.4rem;padding:0;border:0;box-sizing:border-box;font-family:inherit;font-size:12px;line-height:1.4rem;color:inherit;background:transparent}',
  '[data-taro-node="textarea"]{display:block;width:300px;height:150px;padding:0;border:0;box-sizing:border-box;font-family:inherit;font-size:16px;line-height:normal;color:inherit;background:transparent}',
  '[data-taro-node="scroll-view"],[data-taro-node="scrollview"]{display:block;width:100%;box-sizing:border-box}',
  '[data-taro-node="scroll-view"][scrolly="true"],[data-taro-node="scrollview"][scrolly="true"],[data-taro-node="scroll-view"][scrolly=""],[data-taro-node="scrollview"][scrolly=""],[data-taro-node="scroll-view"][scroll-y="true"],[data-taro-node="scrollview"][scroll-y="true"]{overflow-y:auto}',
  '[data-taro-node="root-portal"]{display:contents}',
  '[data-taro-node="image"][mode="aspectFit"]{object-fit:contain}',
  '[data-taro-node="image"][mode="aspectFill"]{object-fit:cover}',
  '[data-taro-node="picker-view"]{position:relative;display:flex;width:100%;height:240px;overflow:hidden}',
  '[data-taro-node="picker-view"]::after{content:"";position:absolute;left:0;right:0;top:50%;height:var(--taro-replay-picker-item-height,34px);box-sizing:border-box;border-top:1px solid #e5e5e5;border-bottom:1px solid #e5e5e5;transform:translateY(-50%);pointer-events:none}',
  '[data-taro-node="picker-view"]::before{content:"";position:absolute;inset:0;z-index:1;background:linear-gradient(to bottom,rgba(255,255,255,.95),rgba(255,255,255,0) 40%,rgba(255,255,255,0) 60%,rgba(255,255,255,.95));pointer-events:none}',
  '[data-taro-node="picker-view-column"]{position:relative;display:block;flex:1;height:100%;overflow:hidden}',
  '[data-taro-node="picker-view-column"]>[data-taro-picker-row]{position:absolute;left:0;top:calc(50% + (var(--taro-replay-picker-row,0) - var(--taro-replay-picker-selected,0))*var(--taro-replay-picker-item-height,34px));width:100%;height:var(--taro-replay-picker-item-height,34px);box-sizing:border-box;transform:translateY(-50%)}',
  '[data-taro-unsupported]{outline:1px dashed #d20a10}',
].join('\n');

/** Converts WXSS lengths, flooring literal rpx font sizes as in the verified native fixture. */
export function normalizeReplayRpx(css: string, width: number): string {
  const scale = (Number.isFinite(width) && width > 0 ? width : 375) / 750;
  return css.replace(
    /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[^\\)])*\)|((?:^|[;{])\s*font-size\s*:\s*)(-?(?:\d+(?:\.\d*)?|\.\d+))rpx\b(?=\s*(?:;|}|!important\b|$))|(^|[^\w.-])(-?(?:\d+(?:\.\d*)?|\.\d+))rpx\b/gi,
    (
      match: string,
      fontDeclaration: string | undefined,
      fontValue: string | undefined,
      prefix: string | undefined,
      value: string | undefined,
    ) => {
      if (fontValue !== undefined)
        return `${fontDeclaration}${Math.floor(Number(fontValue) * scale)}px`;
      if (value === undefined) return match;
      return `${prefix}${Number((Number(value) * scale).toFixed(6))}px`;
    },
  );
}

/** Runtime CSS is untrusted; unlike build CSS its URLs must cross the Replay URL policy. */
export function sanitizeReplayStyle(
  css: string,
  sanitizeUrl: (url: string) => string,
  blockMedia: boolean,
): string {
  // CSS accepts some EOF-terminated URL tokens. Drop malformed runtime styles rather
  // than letting an incomplete token bypass the structured URL scanner below.
  let quote = '';
  let depth = 0;
  for (let index = 0; index < css.length; index++) {
    const char = css[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2);
      if (end < 0) return '';
      index = end + 1;
    } else if (char === '(') depth++;
    else if (char === ')' && --depth < 0) return '';
  }
  if (quote || depth) return '';
  const decode = (value: string): string =>
    value.replace(
      /\\([\da-f]{1,6})\s?|\\([^\r\n])|\\\r?\n/gi,
      (_match, hex: string | undefined, literal: string | undefined) => {
        if (!hex) return literal ?? '';
        const code = parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
      },
    );
  const quoted = (value: string): string => JSON.stringify(value).replace(/</g, '\\3c ');
  // Parse URL tokens before strings, including escaped CSS identifiers and URL contents.
  return css.replace(
    /\/\*[\s\S]*?\*\/|(?:[a-z_-]|\\(?:[\da-f]{1,6}\s?|.))+(?:\s*)\((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\[\s\S]|[^()"'\\])*\)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/gi,
    (token) => {
      if (token.startsWith('/*')) return '';
      const open = token.indexOf('(');
      if (open >= 0 && decode(token.slice(0, open)).trim().toLowerCase() === 'url') {
        let value = token.slice(open + 1, -1).trim();
        if (/^["']/.test(value)) value = value.slice(1, -1);
        return `url(${quoted(blockMedia ? '' : sanitizeUrl(decode(value)))})`;
      }
      if (open >= 0) {
        // image-set() and other functions can contain string URLs.
        return (
          token.slice(0, open + 1) +
          sanitizeReplayStyle(token.slice(open + 1, -1), sanitizeUrl, blockMedia) +
          ')'
        );
      }
      const value = decode(token.slice(1, -1));
      return /^(?:[a-z][\w+.-]*:|\/\/)/i.test(value.trim())
        ? quoted(blockMedia ? '' : sanitizeUrl(value))
        : token;
    },
  );
}
