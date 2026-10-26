import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGreeting, renderGreeting } from "../src/greeting.js";

function mockFetch(body, status = 200) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok: status < 400, status, json: async () => body };
  };
  return { impl, calls };
}

test("fetchGreeting calls GET /greeting and returns the body", async () => {
  const { impl, calls } = mockFetch({ message: "Hello" });
  assert.deepEqual(await fetchGreeting("http://api.test", impl), { message: "Hello" });
  assert.deepEqual(calls, ["http://api.test/greeting"]);
});

test("fetchGreeting throws on API errors", async () => {
  const { impl } = mockFetch({}, 500);
  await assert.rejects(fetchGreeting("http://api.test", impl), /500/);
});

test("renderGreeting shows the message", () => {
  assert.equal(renderGreeting({ message: "Hello" }), "<h1>Hello</h1>");
});
