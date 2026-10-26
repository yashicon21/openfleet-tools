import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "../src/server.js";

test("GET /greeting returns the greeting", async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/greeting`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { message: "Hello" });
  } finally {
    server.close();
  }
});

test("unknown routes return 404", async () => {
  const server = createServer().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
