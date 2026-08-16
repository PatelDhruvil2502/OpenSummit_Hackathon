import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import { createWorkerHarness } from "./helpers/worker-harness.mjs";

let harness;
let anonymous;
let authenticated;

before(async () => {
  harness = await createWorkerHarness("rendered-html");
  anonymous = harness.anonymous;
  authenticated = harness.client({
    id: "rendered-html-user",
    email: "renderer@example.test",
    name: "Rendered HTML Reviewer",
  });
});

after(async () => {
  await harness?.dispose();
});

async function render(pathname = "/", { signedIn = false } = {}) {
  return (signedIn ? authenticated : anonymous).request(pathname, {
    headers: { accept: "text/html" },
  });
}

test("server-renders the finished WageShield landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>WageShield H-1B \| Evidence first\. Human reviewed\.<\/title>/i);
  assert.match(html, /Turn scattered employment records into a clear evidence map/);
  assert.match(html, /Four checks\. Every conclusion stays inspectable/);
  assert.match(html, /Private case storage/);
  assert.match(html, /Not legal advice/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/i);
});

test("server-renders the methodology and case-list routes", async () => {
  const [methodology, cases] = await Promise.all([
    render("/methodology"),
    render("/cases", { signedIn: true }),
  ]);
  assert.equal(methodology.status, 200);
  assert.equal(cases.status, 200);
  assert.match(await methodology.text(), /Document understanding can assist\. Versioned code owns the conclusion/);
  assert.match(await cases.text(), /My evidence reviews/);
});

test("keeps safety language, social metadata, and primary-source links in the product", async () => {
  const [home, methodology, sourceCorpus, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/methodology/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/sources.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(home, /not a legal determination/i);
  assert.match(methodology, /responsible abstention/i);
  for (const factSheet of ["62g", "62i", "62h", "62j"]) {
    assert.match(sourceCorpus, new RegExp(`dol\\.gov/.+/${factSheet}-h1b`, "i"));
  }
  assert.match(layout, /new URL\("\/og-launch\.png", origin\)/);
  assert.match(layout, /card: "summary_large_image"/);
  assert.doesNotMatch(`${home}\n${methodology}`, /you are owed|guaranteed outcome|filed automatically/i);
});
