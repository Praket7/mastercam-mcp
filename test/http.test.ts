import test from "node:test";
import assert from "node:assert/strict";
import { hostnameOf, classifyRequest, isLocalHost } from "../src/http-security.js";
import type { SecurityConfig } from "../src/http-security.js";

const baseConfig: SecurityConfig = { allowedOrigins: new Set(), remote: false };

test("hostnameOf parses IPv4 and bare hosts (HTTP-05)", () => {
  assert.equal(hostnameOf("127.0.0.1:8787"), "127.0.0.1");
  assert.equal(hostnameOf("localhost"), "localhost");
});

test("hostnameOf parses IPv6 hosts correctly (HTTP-05)", () => {
  assert.equal(hostnameOf("[::1]:8787"), "::1");
  assert.equal(hostnameOf("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(hostnameOf("[::1]"), "::1");
});

test("isLocalHost accepts loopback forms including IPv6", () => {
  assert.equal(isLocalHost("[::1]:8787"), true);
  assert.equal(isLocalHost("localhost:8787"), true);
  assert.equal(isLocalHost("evil.example.com:80"), false);
});

test("unknown paths return 404", () => {
  const verdict = classifyRequest("GET", "/other", {}, baseConfig);
  assert.equal(verdict.status, 404);
});

test("invalid Origin returns 403 even without a token (HTTP-01)", () => {
  const config: SecurityConfig = { allowedOrigins: new Set(["http://localhost:5173"]), remote: false };
  const verdict = classifyRequest("POST", "/mcp", { origin: "https://evil.example", host: "127.0.0.1:8787" }, config);
  assert.equal(verdict.status, 403);
});

test("allowed Origin passes the origin check", () => {
  const config: SecurityConfig = { allowedOrigins: new Set(["http://localhost:5173"]), remote: false };
  const verdict = classifyRequest("POST", "/mcp", { origin: "http://localhost:5173", host: "127.0.0.1:8787" }, config);
  assert.equal(verdict.status, 200);
});

test("browser-originated requests to a remote-flagged host are rejected", () => {
  const verdict = classifyRequest("POST", "/mcp", { origin: "https://evil.example", host: "0.0.0.0:8787" }, baseConfig);
  assert.equal(verdict.status, 403);
});

test("token enforcement returns 401 for missing or wrong bearer", () => {
  const config: SecurityConfig = { token: "secret-token-123", allowedOrigins: new Set(), remote: false };
  const missing = classifyRequest("POST", "/mcp", { host: "127.0.0.1:8787" }, config);
  assert.equal(missing.status, 401);
  const wrong = classifyRequest("POST", "/mcp", { host: "127.0.0.1:8787", authorization: "Bearer nope" }, config);
  assert.equal(wrong.status, 401);
  const right = classifyRequest("POST", "/mcp", { host: "127.0.0.1:8787", authorization: "Bearer secret-token-123" }, config);
  assert.equal(right.status, 200);
});

test("remote mode without a token always requires auth", () => {
  const config: SecurityConfig = { allowedOrigins: new Set(), remote: true };
  const verdict = classifyRequest("POST", "/mcp", { host: "example.com:8787" }, config);
  assert.equal(verdict.status, 401);
});

test("non-loopback host with token is rejected when not remote", () => {
  const config: SecurityConfig = { token: "secret-token-123", allowedOrigins: new Set(), remote: false };
  const verdict = classifyRequest("POST", "/mcp", { host: "192.168.1.5:8787", authorization: "Bearer secret-token-123" }, config);
  assert.equal(verdict.status, 403);
});
