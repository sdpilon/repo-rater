#!/usr/bin/env node
// Re-embed repos.json into tracker.html's `const DATA = ...` block.
// Uses slice-based splicing, not String.replace — README content contains
// `$'`/`$$` sequences that replace() would expand as substitution patterns.
const fs = require("fs");
const dir = __dirname;
let html = fs.readFileSync(`${dir}/tracker.html`, "utf8");
const start = html.indexOf("const DATA = ");
const end = html.indexOf("\nconst ASSESS = {");
if (start < 0 || end < 0 || end < start)
  throw new Error("DATA/ASSESS markers not found");
const data = JSON.stringify(
  JSON.parse(fs.readFileSync(`${dir}/repos.json`, "utf8")),
).replace(/<\/script/gi, "<\\/script");
html = html.slice(0, start) + "const DATA = " + data + ";\n" + html.slice(end);
fs.writeFileSync(`${dir}/tracker.html`, html);
console.log(`injected ${data.length} bytes into tracker.html`);
