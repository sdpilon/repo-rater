import { marked } from "marked";

export function renderReadme(markdown: string): string {
  return marked.parse(markdown, { gfm: true }) as string;
}
