import assert from "node:assert/strict";
import test from "node:test";

import { publicAppOrigin } from "./runtime-flags";

function preserveEnvironment(names: string[]): () => void {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("public app origin prefers a valid explicit HTTPS origin", () => {
  const restore = preserveEnvironment(["PUBLIC_APP_URL", "RENDER_EXTERNAL_URL"]);
  try {
    process.env.PUBLIC_APP_URL = " https://demo.example.test/ ";
    process.env.RENDER_EXTERNAL_URL = "https://ignored.onrender.com";
    assert.equal(publicAppOrigin(), "https://demo.example.test");
  } finally {
    restore();
  }
});

test("public app origin accepts Render's trusted URL and rejects unsafe declarations", () => {
  const restore = preserveEnvironment(["PUBLIC_APP_URL", "RENDER_EXTERNAL_URL"]);
  try {
    delete process.env.PUBLIC_APP_URL;
    process.env.RENDER_EXTERNAL_URL = "https://wageshield-demo.onrender.com";
    assert.equal(publicAppOrigin(), "https://wageshield-demo.onrender.com");

    process.env.PUBLIC_APP_URL = "http://wageshield.example.test";
    assert.equal(publicAppOrigin(), null);
    process.env.PUBLIC_APP_URL = "https://wageshield.example.test/reset";
    assert.equal(publicAppOrigin(), null);
  } finally {
    restore();
  }
});

test("only localhost request origins are accepted as an undeclared development fallback", () => {
  const restore = preserveEnvironment(["PUBLIC_APP_URL", "RENDER_EXTERNAL_URL"]);
  try {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    assert.equal(
      publicAppOrigin(new Request("http://localhost:3000/forgot-password")),
      "http://localhost:3000",
    );
    assert.equal(
      publicAppOrigin(new Request("https://attacker.example/forgot-password")),
      null,
    );
  } finally {
    restore();
  }
});
