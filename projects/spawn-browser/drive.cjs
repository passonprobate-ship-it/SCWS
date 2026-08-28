#!/usr/bin/env node
/**
 * CDP driver for the shared browser. Usage:
 *   node drive.cjs goto <url>          — navigate the first page tab
 *   node drive.cjs shot <outfile.png>  — screenshot current page
 *   node drive.cjs url                 — print current URL + title
 * Any agent (Claude, Grok, ...) on this box can do the same against
 * http://127.0.0.1:9222 — multiple CDP clients are allowed.
 */
const puppeteer = require("/usr/lib/node_modules/puppeteer-core");

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  if (cmd === "goto") {
    await page.goto(arg, { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log(`OK: ${page.url()} — ${await page.title()}`);
  } else if (cmd === "shot") {
    await page.screenshot({ path: arg });
    console.log(`OK: ${arg}`);
  } else if (cmd === "url") {
    console.log(`${page.url()} — ${await page.title()}`);
  } else {
    console.error("usage: drive.cjs goto <url> | shot <file> | url");
    process.exit(1);
  }
  await browser.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
