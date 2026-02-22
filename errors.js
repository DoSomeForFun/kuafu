/**
 * Unified Error Classification Module
 * 
 * Provides standardized error type classification across the entire Kuafu runtime.
 * This enables consistent retry logic, circuit breaking, and observability.
 */

import { telemetry } from "./telemetry.js";

/**
 * Error type enumeration
 */
export const ErrorType = {
  // Transient errors (eligible for retry)
  TRANSIENT_TIMEOUT: "transient_timeout",
  TRANSIENT_NETWORK: "transient_network",
  TRANSIENT_RATE_LIMIT: "transient_rate_limit",
  TRANSIENT_SERVICE_UNAVAILABLE: "transient_service_unavailable",

  // Permanent errors (should not retry)
  PERMANENT_NOT_FOUND: "permanent_not_found",
  PERMANENT_AUTH: "permanent_auth",
  PERMANENT_INVALID_INPUT: "permanent_invalid_input",
  PERMANENT_FORBIDDEN: "permanent_forbidden",

  // System errors (unexpected, may indicate bugs)
  SYSTEM: "system",

  // Unknown
  UNKNOWN: "unknown"
};

/**
 * HTTP status code to error type mapping
 */
const HTTP_STATUS_MAP = {
  400: ErrorType.PERMANENT_INVALID_INPUT,
  401: ErrorType.PERMANENT_AUTH,
  403: ErrorType.PERMANENT_FORBIDDEN,
  404: ErrorType.PERMANENT_NOT_FOUND,
  429: ErrorType.TRANSIENT_RATE_LIMIT,
  500: ErrorType.SYSTEM,
  502: ErrorType.TRANSIENT_SERVICE_UNAVAILABLE,
  503: ErrorType.TRANSIENT_SERVICE_UNAVAILABLE,
  504: ErrorType.TRANSIENT_TIMEOUT
};

/**
 * Error message patterns for classification
 */
const ERROR_PATTERNS = {
  [ErrorType.TRANSIENT_TIMEOUT]: /timeout|timed out|etimedout|ehostunreach|eai_again|socket hang up/i,
  [ErrorType.TRANSIENT_NETWORK]: /econnreset|econnrefused|econnaborted|enotfound|enetunreach|epipe|network|ehostunreach/i,
  [ErrorType.TRANSIENT_RATE_LIMIT]: /429|rate limit|too many requests/i,
  [ErrorType.TRANSIENT_SERVICE_UNAVAILABLE]: /502|503|504|service unavailable|bad gateway|gateway timeout/i,
  [ErrorType.PERMANENT_AUTH]: /401|unauthorized|authentication|api.key|api key|invalid.*token/i,
  [ErrorType.PERMANENT_FORBIDDEN]: /403|forbidden|access denied|permission denied/i,
  [ErrorType.PERMANENT_NOT_FOUND]: /404|not found|enotdir|enoent/i,
  [ErrorType.PERMANENT_INVALID_INPUT]: /400|bad request|invalid.*argument|validation.*error/i,
  [ErrorType.SYSTEM]: /eacces|eperm|permission denied|operation not permitted|resource busy|text file busy/i
};

/**
 * Classify error based on HTTP response or error message
 * 
 * @param {Error|string} error - The error object or message string
 * @param {object} response - Optional HTTP response with status property
 * @returns {string} Error type from ErrorType enum
 */
export function classifyError(error, response = null) {
  // 1. HTTP status code takes priority
  if (response?.status) {
    const httpType = HTTP_STATUS_MAP[response.status];
    if (httpType) {
      return httpType;
    }
  }

  // 2. Parse error message
  const errorText = String(error?.message || error || "");

  for (const [errorType, pattern] of Object.entries(ERROR_PATTERNS)) {
    if (pattern.test(errorText)) {
      return errorType;
    }
  }

  // 3. Default to unknown
  return ErrorType.UNKNOWN;
}

/**
 * Check if an error type is transient (eligible for retry)
 * 
 * @param {string} errorType - Error type from ErrorType enum
 * @returns {boolean} True if the error can be retried
 */
export function isTransientError(errorType) {
  return errorType?.startsWith("transient_");
}

/**
 * Check if an error type is permanent (should not retry)
 * 
 * @param {string} errorType - Error type from ErrorType enum
 * @returns {boolean} True if the error should not be retried
 */
export function isPermanentError(errorType) {
  return errorType?.startsWith("permanent_");
}

/**
 * Determine if an error should trigger a circuit breaker
 * 
 * @param {string} errorType - Error type from ErrorType enum
 * @returns {boolean} True if the error should count toward circuit breaking
 */
export function isCircuitBreakerTrigger(errorType) {
  // Only count transient errors toward circuit breaking
  // Permanent errors should not trigger circuit breaker
  return isTransientError(errorType);
}

/**
 * Get a human-readable description for an error type
 * 
 * @param {string} errorType - Error type from ErrorType enum
 * @returns {string} Human-readable description
 */
export function getErrorDescription(errorType) {
  const descriptions = {
    [ErrorType.TRANSIENT_TIMEOUT]: "Request timed out",
    [ErrorType.TRANSIENT_NETWORK]: "Network connection failed",
    [ErrorType.TRANSIENT_RATE_LIMIT]: "Rate limit exceeded",
    [ErrorType.TRANSIENT_SERVICE_UNAVAILABLE]: "Service temporarily unavailable",
    [ErrorType.PERMANENT_NOT_FOUND]: "Resource not found",
    [ErrorType.PERMANENT_AUTH]: "Authentication failed",
    [ErrorType.PERMANENT_INVALID_INPUT]: "Invalid input provided",
    [ErrorType.PERMANENT_FORBIDDEN]: "Access forbidden",
    [ErrorType.SYSTEM]: "System error",
    [ErrorType.UNKNOWN]: "Unknown error"
  };
  return descriptions[errorType] || "Unknown error";
}

/**
 * Legacy compatibility: check if bash error is retryable
 * 
 * @param {string} errorText - Error message text
 * @returns {boolean} True if the error is retryable
 */
export function isRetryableBashError(errorText) {
  const errorType = classifyError(new Error(errorText));
  return isTransientError(errorType);
}

/**
 * Create a classified error object with full metadata
 * 
 * @param {Error|string} error - The original error
 * @param {object} response - Optional HTTP response
 * @returns {object} Classified error with metadata
 */
export function createClassifiedError(error, response = null) {
  const errorType = classifyError(error, response);
  const isTransient = isTransientError(errorType);
  const isPermanent = isPermanentError(errorType);

  return {
    original: error,
    message: String(error?.message || error || ""),
    type: errorType,
    description: getErrorDescription(errorType),
    isTransient,
    isPermanent,
    shouldRetry: isTransient,
    shouldTriggerCircuitBreaker: isCircuitBreakerTrigger(errorType),
    response
  };
}
