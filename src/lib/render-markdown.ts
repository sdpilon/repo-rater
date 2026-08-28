import { Marked } from "marked";
import type { Token } from "marked";
import createDOMPurify from "dompurify";
import sanitizeHtml from "sanitize-html";

const cache = new Map<string, string>();

/**
 * `sanitize-html` config for the server-side render path — matched to the
 * subset of HTML `marked` actually produces from GFM (headings, lists,
 * tables, task-list checkboxes, images, strikethrough), since its own
 * defaults are narrower than what a README needs.
 *
 * Split from the browser path (real DOMPurify, below) rather than pulling in
 * `isomorphic-dompurify`: that package hard-imports `jsdom` for its Node
 * branch, and jsdom's bundled asset loading references the CommonJS-only
 * `__dirname` global — which doesn't exist in the pure-ESM bundle Nitro's
 * Vercel preset produces, crashing the whole request the moment this module
 * loads server-side.
 */
const SANITIZE_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "img",
    "input",
    "del",
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ["href", "name", "id"],
    img: ["src", "alt", "title"],
    input: ["type", "checked", "disabled"],
  },
};

/** Real DOMPurify (browser DOM, not jsdom) for the client-render path. */
function sanitize(html: string): string {
  if (typeof window !== "undefined") {
    return createDOMPurify(window).sanitize(html);
  }
  return sanitizeHtml(html, SANITIZE_HTML_OPTIONS);
}

function isRelativeUrl(href: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);
}

function resolveAgainst(href: string, base: string): string {
  const resolved = new URL(href.replace(/^[/\\]+/, ""), base);
  return resolved.origin === new URL(base).origin ? resolved.toString() : href;
}

function buildMarked(fullName: string): Marked {
  const blobBase = `https://github.com/${fullName}/blob/HEAD/`;
  const rawBase = `https://raw.githubusercontent.com/${fullName}/HEAD/`;
  const instance = new Marked({ gfm: true, async: false });
  instance.use({
    walkTokens(token: Token) {
      if (token.type === "link" && isRelativeUrl(token.href)) {
        token.href = resolveAgainst(token.href, blobBase);
      } else if (token.type === "image" && isRelativeUrl(token.href)) {
        token.href = resolveAgainst(token.href, rawBase);
      }
    },
  });
  return instance;
}

export function renderReadme(markdown: string, fullName: string): string {
  const key = `${fullName}:${markdown}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const html = buildMarked(fullName).parse(markdown, { async: false });
  const sanitized = sanitize(html);
  cache.set(key, sanitized);
  return sanitized;
}
