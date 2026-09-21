export const ERROR_CODES = [
  "BACKEND_UNAVAILABLE",
  "TIMEOUT",
  "CANCELLED",
  "INVALID_JSON",
  "VALIDATION_FAILED",
  "UNSUPPORTED_TOOL",
  "UNSUPPORTED_CAPABILITY",
  "CAPABILITY_UNAVAILABLE",
  "OPERATION_NOT_FOUND",
  "TARGET_REQUIRED",
  "AMBIGUOUS_TARGET",
  "STALE_PREVIEW",
  "APPROVAL_REQUIRED",
  "APPROVAL_TOKEN_INVALID",
  "APPROVAL_TOKEN_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "DOCUMENT_CHANGED",
  "INVALID_FEED",
  "INVALID_QUANTITY",
  "PROFILE_DENIED",
  "REGISTRATION_CONFLICT",
  "REGENERATION_FAILED",
  "SIMULATION_FAILED",
  "REQUEST_TOO_LARGE",
  "RESPONSE_TOO_LARGE",
  "RATE_LIMITED",
  "AUDIT_DISABLED"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface MastercamError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  remediation?: string;
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "BACKEND_UNAVAILABLE",
  "TIMEOUT",
  "RATE_LIMITED"
]);

const REMEDIATION: Partial<Record<ErrorCode, string>> = {
  BACKEND_UNAVAILABLE: "Check that Mastercam is running with the MCP NET-Hook loaded, then retry.",
  TIMEOUT: "Retry with a larger deadline if the Mastercam operation is legitimately long-running.",
  OPERATION_NOT_FOUND: "Run list_operations or find_operations to get a valid operationId.",
  TARGET_REQUIRED: "Supply an explicit operationId; mutations never fall back to a default target.",
  AMBIGUOUS_TARGET: "Narrow the selection to exactly one operation before mutating.",
  STALE_PREVIEW: "The operation changed since preview; request a fresh preview and approval.",
  APPROVAL_REQUIRED: "Call preview_operation_parameters and apply the returned approvalToken.",
  APPROVAL_TOKEN_INVALID: "Request a new preview; approval tokens are single use.",
  APPROVAL_TOKEN_EXPIRED: "Request a new preview; approval tokens expire quickly by design.",
  UNSUPPORTED_TOOL: "This tool is not implemented by the active backend; see mastercam_capabilities.",
  UNSUPPORTED_CAPABILITY: "The installed Mastercam release has no verified mapping for this capability.",
  PROFILE_DENIED: "Start the server with a less restrictive MASTERCAM_MCP_PROFILE, or stay in read-only mode.",
  VALIDATION_FAILED: "Correct the arguments to match the tool input schema.",
  REQUEST_TOO_LARGE: "Reduce the request payload size.",
  RATE_LIMITED: "Wait for the cooldown before retrying."
};

export function mastercamError(code: ErrorCode, message: string, overrides: Partial<MastercamError> = {}): MastercamError {
  return {
    code,
    message,
    retryable: overrides.retryable ?? RETRYABLE.has(code),
    ...(overrides.remediation ?? REMEDIATION[code] ? { remediation: overrides.remediation ?? REMEDIATION[code] } : {})
  };
}

export class MastercamErrorImpl extends Error implements MastercamError {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly remediation?: string;
  constructor(code: ErrorCode, message: string, overrides: Partial<MastercamError> = {}) {
    super(message);
    this.name = "MastercamError";
    this.code = code;
    this.retryable = overrides.retryable ?? RETRYABLE.has(code);
    if (overrides.remediation ?? REMEDIATION[code]) this.remediation = overrides.remediation ?? REMEDIATION[code];
  }
}

export function isMastercamError(value: unknown): value is MastercamErrorImpl {
  return value instanceof MastercamErrorImpl;
}
