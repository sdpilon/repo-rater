import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

const cache = new Map<string, string>();

export function renderReadme(markdown: string): string {
  const cached = cache.get(markdown);
  if (cached !== undefined) return cached;
  const html = marked.parse(markdown, { gfm: true, async: false });
  const sanitized = DOMPurify.sanitize(html);
  cache.set(markdown, sanitized);
  return sanitized;
}
