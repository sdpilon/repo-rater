#!/usr/bin/env node
// Regenerates .github/assets/dashboard.png from a running dev server. Point
// it at a database seeded with `pnpm run seed:fake` (see README's "Seeding
// fake data" section for one-time setup), then:
//
//   pnpm dev &
//   pnpm run screenshot
//
// Checks "Hide ignored repos", hides the dev-only SolidStart toolbar, and
// crops to the header/totals plus the first few repo cards.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const DASHBOARD_URL = process.env.SCREENSHOT_URL ?? "http://localhost:3000";
const CARD_COUNT = Number(process.env.SCREENSHOT_CARD_COUNT ?? 4);
const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.github/assets/dashboard.png",
);

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  // Pre-seed localStorage before any app code runs, rather than clicking the
  // checkbox post-load — avoids a race with the persisting effect in
  // src/routes/index.tsx.
  await context.addInitScript(() => {
    localStorage.setItem("hideIgnoredRepos", "true");
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(DASHBOARD_URL, { waitUntil: "networkidle" });
  await page.waitForSelector("article.repo", { timeout: 15000 });

  // Hide any dev-only fixed-position overlay (SolidStart's dev toolbar,
  // Vercel's dev-mode toolbar) so it doesn't show up in the screenshot.
  await page.evaluate(() => {
    document.querySelectorAll("body *").forEach((el) => {
      if (getComputedStyle(el).position === "fixed") {
        el.style.setProperty("display", "none", "important");
      }
    });
  });

  const cards = page.locator("article.repo");
  const cardCount = await cards.count();
  if (cardCount === 0) {
    throw new Error(
      "No repo cards found — is DATABASE_URL pointed at a database seeded via `pnpm run seed:fake`?",
    );
  }

  const lastCardIndex = Math.min(CARD_COUNT, cardCount) - 1;
  const lastCardBox = await cards.nth(lastCardIndex).boundingBox();
  const clipHeight = Math.ceil(lastCardBox.y + lastCardBox.height + 20);

  await page.screenshot({
    path: OUTPUT_PATH,
    clip: { x: 0, y: 0, width: 1400, height: clipHeight },
  });

  if (consoleErrors.length > 0) {
    console.warn("Console errors during capture (screenshot still written):", consoleErrors);
  }
  console.log(`Wrote ${OUTPUT_PATH} (${cardCount >= CARD_COUNT ? CARD_COUNT : cardCount} cards, ${clipHeight}px tall)`);
} finally {
  await browser.close();
}
