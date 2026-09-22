import { z } from "zod";
import type { Profile } from "./contracts.js";

export const ConfigSchema = z.object({
  profile: z.enum(["read", "write", "all"]).default("read"),
  hardReadOnly: z.boolean().default(false),
  backend: z.enum(["mock", "live"]).default("mock"),
  pipe: z.string().default("\\\\.\\pipe\\mastercam-mcp-default"),
  audit: z.object({
    enabled: z.boolean().default(true),
    path: z.string().optional(),
    maxFileBytes: z.number().int().positive().max(100 * 1024 * 1024).default(10 * 1024 * 1024),
    maxRotatedFiles: z.number().int().positive().max(100).default(5)
  }).default({}),
  http: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(8787),
    token: z.string().optional(),
    allowedOrigins: z.array(z.string()).default([]),
    allowRemote: z.boolean().default(false),
    maxRequestBodyBytes: z.number().int().positive().max(100 * 1024 * 1024).default(2 * 1024 * 1024),
    maxConcurrency: z.number().int().positive().max(1000).default(32),
    requestTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
    sessionTtlMs: z.number().int().positive().max(86_400_000).default(1_800_000)
  }).default({}),
  transport: z.object({
    connectTimeoutMs: z.number().int().positive().max(60_000).default(2000),
    idleTimeoutMs: z.number().int().positive().max(300_000).default(30_000),
    maxResponseBytes: z.number().int().positive().max(100 * 1024 * 1024).default(4 * 1024 * 1024),
    circuitBreaker: z.object({
      failureThreshold: z.number().int().positive().max(100).default(3),
      cooldownMs: z.number().int().positive().max(300_000).default(5000),
      halfOpenSuccesses: z.number().int().positive().max(100).default(2)
    }).default({})
  }).default({})
});

export type Config = z.infer<typeof ConfigSchema>;

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value !== "0" && value !== "false" && value !== "";
}

function parseNumber(value: string | undefined, defaultValue: number, min: number, max: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid value: ${value}, expected integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map(v => v.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  const raw = {
    profile: process.env.MASTERCAM_MCP_PROFILE ?? "read",
    hardReadOnly: parseBoolean(process.env.MASTERCAM_MCP_HARD_READ_ONLY, false),
    backend: (process.env.MASTERCAM_MCP_BACKEND ?? "mock") as "mock" | "live",
    pipe: process.env.MASTERCAM_MCP_PIPE ?? "\\\\.\\pipe\\mastercam-mcp-default",
    audit: {
      enabled: parseBoolean(process.env.MASTERCAM_MCP_AUDIT, true),
      path: process.env.MASTERCAM_MCP_AUDIT_PATH,
      maxFileBytes: parseNumber(process.env.MASTERCAM_MCP_AUDIT_MAX_BYTES, 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      maxRotatedFiles: parseNumber(process.env.MASTERCAM_MCP_AUDIT_MAX_FILES, 5, 1, 100)
    },
    http: {
      host: process.env.MASTERCAM_MCP_HTTP_HOST ?? "127.0.0.1",
      port: parseNumber(process.env.MASTERCAM_MCP_HTTP_PORT, 8787, 1, 65535),
      token: process.env.MASTERCAM_MCP_HTTP_TOKEN,
      allowedOrigins: parseStringArray(process.env.MASTERCAM_MCP_ALLOWED_ORIGINS),
      allowRemote: parseBoolean(process.env.MASTERCAM_MCP_HTTP_ALLOW_REMOTE, false),
      maxRequestBodyBytes: parseNumber(process.env.MASTERCAM_MCP_HTTP_MAX_BODY_BYTES, 2 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      maxConcurrency: parseNumber(process.env.MASTERCAM_MCP_HTTP_MAX_CONCURRENCY, 32, 1, 1000),
      requestTimeoutMs: parseNumber(process.env.MASTERCAM_MCP_HTTP_REQUEST_TIMEOUT_MS, 120_000, 1000, 600_000),
      sessionTtlMs: parseNumber(process.env.MASTERCAM_MCP_HTTP_SESSION_TTL_MS, 1_800_000, 1000, 86_400_000)
    },
    transport: {
      connectTimeoutMs: parseNumber(process.env.MASTERCAM_MCP_CONNECT_TIMEOUT_MS, 2000, 100, 60_000),
      idleTimeoutMs: parseNumber(process.env.MASTERCAM_MCP_IDLE_TIMEOUT_MS, 30_000, 1000, 300_000),
      maxResponseBytes: parseNumber(process.env.MASTERCAM_MCP_MAX_RESPONSE_BYTES, 4 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      circuitBreaker: {
        failureThreshold: parseNumber(process.env.MASTERCAM_MCP_CB_THRESHOLD, 3, 1, 100),
        cooldownMs: parseNumber(process.env.MASTERCAM_MCP_CB_COOLDOWN_MS, 5000, 100, 300_000),
        halfOpenSuccesses: parseNumber(process.env.MASTERCAM_MCP_CB_HALF_OPEN, 2, 1, 100)
      }
    }
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; ");
    throw new Error(`Configuration validation failed: ${errors}`);
  }

  return result.data;
}

export function validateProfileConfig(profile: string, hardReadOnly: string): { profile: Profile; hardReadOnly: boolean } {
  const validProfiles = ["read", "write", "all"] as const;
  if (!validProfiles.includes(profile as any)) {
    throw new Error(`Invalid profile: ${profile}. Valid profiles: ${validProfiles.join(", ")}`);
  }
  return { profile: profile as Profile, hardReadOnly: hardReadOnly !== "0" };
}

export const config = loadConfig();