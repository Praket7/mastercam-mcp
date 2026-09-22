import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeHttpBinding,
  classifyAccess,
  classifyRequest,
  hostnameOf,
  isLocalHost,
  isLoopbackAddress
} from "../src/http-security.js";

const localConfig = {
  allowedOrigins: new Set<string>(),
  remote: false
};

test("hostname and peer parsing recognizes IPv4, mapped IPv4, localhost, and bracketed IPv6", () => {
  assert.equal(hostnameOf("127.0.0.1:8787"), "127.0.0.1");
  assert.equal(hostnameOf("localhost:8787"), "localhost");
  assert.equal(hostnameOf("[::1]:8787"), "::1");
  assert.equal(isLocalHost("127.0.0.1:8787"), true);
  assert.equal(isLocalHost("[::1]:8787"), true);
  assert.equal(isLocalHost("evil.example:8787"), false);
  assert.equal(isLoopbackAddress("127.0.0.42"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.5"), false);
});

test("local MCP and health access reject DNS-rebinding Host values", () => {
  assert.equal(
    classifyRequest("POST", "/mcp", { host: "evil.example:8787" }, localConfig).status,
    403
  );
  assert.equal(
    classifyAccess({ host: "evil.example:8787" }, localConfig).status,
    403
  );
});

test("local access rejects a remote peer even when it forges a loopback Host header", () => {
  const verdict = classifyRequest(
    "POST",
    "/mcp",
    { host: "127.0.0.1:8787", remoteAddress: "203.0.113.9" },
    localConfig
  );
  assert.equal(verdict.status, 403);
  assert.equal(verdict.message, "Peer address not allowed");
});

test("local mode refuses non-loopback bind addresses at startup", () => {
  assert.doesNotThrow(() => assertSafeHttpBinding("127.0.0.1", false));
  assert.doesNotThrow(() => assertSafeHttpBinding("::1", false));
  assert.doesNotThrow(() => assertSafeHttpBinding("localhost", false));
  assert.throws(() => assertSafeHttpBinding("0.0.0.0", false), /Refusing non-loopback HTTP bind/);
  assert.throws(() => assertSafeHttpBinding("192.168.1.10", false), /Refusing non-loopback HTTP bind/);
  assert.doesNotThrow(() => assertSafeHttpBinding("0.0.0.0", true));
});

test("browser Origin must be explicitly allowed", () => {
  assert.equal(
    classifyRequest(
      "POST",
      "/mcp",
      { host: "127.0.0.1:8787", origin: "https://evil.example" },
      localConfig
    ).status,
    403
  );

  const allowed = {
    allowedOrigins: new Set(["https://trusted.example"]),
    remote: false
  };
  assert.equal(
    classifyRequest(
      "POST",
      "/mcp",
      { host: "127.0.0.1:8787", origin: "https://trusted.example" },
      allowed
    ).status,
    200
  );
});

test("remote mode requires both an allow-listed Origin and bearer token", () => {
  const config = {
    token: "secret-token",
    allowedOrigins: new Set(["https://trusted.example"]),
    remote: true
  };
  assert.equal(
    classifyAccess(
      { host: "cam.example", origin: "https://trusted.example" },
      config
    ).status,
    401
  );
  assert.equal(
    classifyAccess(
      {
        host: "cam.example",
        origin: "https://trusted.example",
        authorization: "Bearer secret-token"
      },
      config
    ).status,
    200
  );
  assert.equal(
    classifyAccess(
      {
        host: "cam.example",
        origin: "https://evil.example",
        authorization: "Bearer secret-token"
      },
      config
    ).status,
    403
  );
});

test("unknown paths remain 404", () => {
  assert.equal(
    classifyRequest("POST", "/nope", { host: "127.0.0.1:8787" }, localConfig).status,
    404
  );
});
