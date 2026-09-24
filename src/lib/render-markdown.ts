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

function isRelativeUrl(href: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);
}

function resolveAgainst(href: string, base: string): string {
  const resolved = new URL(href.replace(/^[/\\]+/, ""), base);
  return resolved.origin === new URL(base).origin ? resolved.toString() : href;
}

/**
 * Real DOMPurify (browser DOM, not jsdom) for the client-render path.
 *
 * `walkTokens` below only rewrites markdown-syntax links/images ("[x](y)",
 * "![x](y)") — raw inline HTML in a README (e.g. `<img src="docs/logo.png">`,
 * common for badges/centered logos) bypasses `marked` entirely and reaches
 * here untouched, so relative `src`/`href` attributes on it are resolved
 * post-sanitize instead, once per DOM node, rather than with a second parse.
 */
function sanitize(html: string, blobBase: string, rawBase: string): string {
  if (typeof window !== "undefined") {
    const DOMPurify = createDOMPurify(window);
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "IMG") {
        const src = node.getAttribute("src");
        if (src && isRelativeUrl(src)) {
          node.setAttribute("src", resolveAgainst(src, rawBase));
        }
      } else if (node.tagName === "A") {
        const href = node.getAttribute("href");
        if (href && isRelativeUrl(href)) {
          node.setAttribute("href", resolveAgainst(href, blobBase));
        }
      }
    });
    return DOMPurify.sanitize(html);
  }
  return sanitizeHtml(html, {
    ...SANITIZE_HTML_OPTIONS,
    transformTags: {
      img: (tagName, attribs) => {
        if (attribs.src && isRelativeUrl(attribs.src)) {
          attribs.src = resolveAgainst(attribs.src, rawBase);
        }
        return { tagName, attribs };
      },
      a: (tagName, attribs) => {
        if (attribs.href && isRelativeUrl(attribs.href)) {
          attribs.href = resolveAgainst(attribs.href, blobBase);
        }
        return { tagName, attribs };
      },
    },
  });
}

function buildMarked(blobBase: string, rawBase: string): Marked {
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
  const blobBase = `https://github.com/${fullName}/blob/HEAD/`;
  const rawBase = `https://raw.githubusercontent.com/${fullName}/HEAD/`;
  const html = buildMarked(blobBase, rawBase).parse(markdown, { async: false });
  const sanitized = sanitize(html, blobBase, rawBase);
  cache.set(key, sanitized);
  return sanitized;
}
