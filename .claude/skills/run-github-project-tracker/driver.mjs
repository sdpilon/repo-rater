#!/usr/bin/env node
// Launches `serve .`, drives tracker.html with Playwright Chromium, screenshots it.
// Usage: pnpm run tracker:screenshot
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3000;
const SCREENSHOT_DIR = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 301) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`server never came up at ${url}`);
}

const server = spawn("pnpm", ["exec", "serve", ".", "-l", String(PORT)], {
  cwd: new URL("../../../", import.meta.url).pathname,
  stdio: "ignore",
});

try {
  await waitForServer(`http://localhost:${PORT}/tracker`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto(`http://localhost:${PORT}/tracker`);
  await page.waitForSelector(".repo");

  const repoCount = await page.locator(".repo").count();
  const title = await page.title();
  console.log(`loaded: "${title}" — ${repoCount} repo cards rendered`);

  await page.screenshot({ path: `${SCREENSHOT_DIR}dashboard.png`, fullPage: false });

  // Drive the one interactive element: expand a repo's "Commits" <details>.
  await page.locator(".raw summary").first().click();
  await page.waitForSelector(".raw details[open]");
  await page.screenshot({ path: `${SCREENSHOT_DIR}dashboard-expanded.png`, fullPage: false });

  console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "console: no errors");

  await browser.close();
} finally {
  server.kill();
}
