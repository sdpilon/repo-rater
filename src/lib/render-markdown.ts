import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";

export function renderReadme(markdown: string): string {
  const html = marked.parse(markdown, { gfm: true }) as string;
  return DOMPurify.sanitize(html);
}
