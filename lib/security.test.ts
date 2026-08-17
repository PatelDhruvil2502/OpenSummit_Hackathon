import assert from "node:assert/strict";
import test from "node:test";

import { mutationGuard } from "./security";

function preserveEnvironment(names: string[]): () => void {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function localMutation(
  origin: string,
  options: { host?: string; requestUrl?: string; headers?: HeadersInit } = {},
): Request {
  return new Request(options.requestUrl ?? "http://0.0.0.0:3000/api/auth/signup", {
    method: "POST",
    headers: {
      host: options.host ?? "localhost:3000",
      origin,
      "sec-fetch-site": "same-origin",
      ...Object.fromEntries(new Headers(options.headers)),
    },
  });
}

test("local mutations accept loopback browser origins when Next binds to 0.0.0.0", () => {
  const restore = preserveEnvironment(["PUBLIC_APP_URL", "RENDER_EXTERNAL_URL"]);
  try {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;

    assert.equal(mutationGuard(localMutation("http://localhost:3000")), null);
    assert.equal(
      mutationGuard(
        localMutation("http://127.0.0.1:3000", {
          host: "127.0.0.1:3000",
          requestUrl: "http://n/api/auth/signup",
        }),
      ),
      null,
    );
  } finally {
    restore();
  }
});

test("local mutations still reject different ports, protocols, and non-local origins", async () => {
  const restore = preserveEnvironment(["PUBLIC_APP_URL", "RENDER_EXTERNAL_URL"]);
  try {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;

    for (const origin of [
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "https://localhost:3000",
      "https://attacker.example",
      "not-an-origin",
    ]) {
      const response = mutationGuard(localMutation(origin));
      assert.ok(response);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "CSRF_REJECTED");
    }
  } finally {
    restore();
  }
});

test("an undeclared non-loopback Host is never trusted as an origin source", () => {
  const restore = preserveEnvironment(["PUBLIC_APP_URL", "RENDER_EXTERNAL_URL"]);
  try {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    const response = mutationGuard(
      localMutation("https://app.example.test", {
        host: "app.example.test",
        requestUrl: "http://internal:3000/api/auth/signup",
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    assert.equal(response?.status, 403);
  } finally {
    restore();
  }
});

test("a configured production origin remains the sole accepted browser origin", () => {
  const restore = preserveEnvironment(["PUBLIC_APP_URL", "RENDER_EXTERNAL_URL"]);
  try {
    process.env.PUBLIC_APP_URL = "https://wageshield.example.test";
    delete process.env.RENDER_EXTERNAL_URL;

    const productionRequest = new Request("http://internal:3000/api/auth/signup", {
      method: "POST",
      headers: {
        host: "internal:3000",
        origin: "https://wageshield.example.test",
        "x-forwarded-host": "wageshield.example.test",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(mutationGuard(productionRequest), null);

    const forgedLocalOrigin = new Request(productionRequest, {
      headers: {
        ...Object.fromEntries(productionRequest.headers),
        origin: "http://localhost:3000",
      },
    });
    assert.equal(mutationGuard(forgedLocalOrigin)?.status, 403);
  } finally {
    restore();
  }
});

test("Sec-Fetch-Site cross-site is rejected even when Origin otherwise matches", () => {
  const restore = preserveEnvironment(["PUBLIC_APP_URL", "RENDER_EXTERNAL_URL"]);
  try {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    const response = mutationGuard(
      localMutation("http://localhost:3000", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    assert.equal(response?.status, 403);
  } finally {
    restore();
  }
});
