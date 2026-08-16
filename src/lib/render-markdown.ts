import { Marked } from "marked";
import type { Token } from "marked";
import DOMPurify from "isomorphic-dompurify";

const cache = new Map<string, string>();

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
  const sanitized = DOMPurify.sanitize(html);
  cache.set(key, sanitized);
  return sanitized;
}
