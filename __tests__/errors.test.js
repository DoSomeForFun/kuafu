/**
 * @jest-environment node
 */

import { classifyError, ErrorType, isTransientError, isRetryableBashError, getErrorDescription } from '../errors.js';

describe('Error Classification', () => {
  describe('classifyError', () => {
    test('HTTP 429 should be TRANSIENT_RATE_LIMIT', () => {
      const errorType = classifyError(new Error('Too Many Requests'), { status: 429 });
      expect(errorType).toBe(ErrorType.TRANSIENT_RATE_LIMIT);
    });

    test('HTTP 503 should be TRANSIENT_SERVICE_UNAVAILABLE', () => {
      const errorType = classifyError(new Error('Service Unavailable'), { status: 503 });
      expect(errorType).toBe(ErrorType.TRANSIENT_SERVICE_UNAVAILABLE);
    });

    test('HTTP 502 should be TRANSIENT_SERVICE_UNAVAILABLE', () => {
      const errorType = classifyError(new Error('Bad Gateway'), { status: 502 });
      expect(errorType).toBe(ErrorType.TRANSIENT_SERVICE_UNAVAILABLE);
    });

    test('HTTP 504 should be TRANSIENT_TIMEOUT', () => {
      const errorType = classifyError(new Error('Gateway Timeout'), { status: 504 });
      expect(errorType).toBe(ErrorType.TRANSIENT_TIMEOUT);
    });

    test('HTTP 404 should be PERMANENT_NOT_FOUND', () => {
      const errorType = classifyError(new Error('Not Found'), { status: 404 });
      expect(errorType).toBe(ErrorType.PERMANENT_NOT_FOUND);
    });

    test('HTTP 401 should be PERMANENT_AUTH', () => {
      const errorType = classifyError(new Error('Unauthorized'), { status: 401 });
      expect(errorType).toBe(ErrorType.PERMANENT_AUTH);
    });

    test('HTTP 403 should be PERMANENT_FORBIDDEN', () => {
      const errorType = classifyError(new Error('Forbidden'), { status: 403 });
      expect(errorType).toBe(ErrorType.PERMANENT_FORBIDDEN);
    });

    test('ETIMEDOUT should be TRANSIENT_TIMEOUT', () => {
      const errorType = classifyError(new Error('ETIMEDOUT'));
      expect(errorType).toBe(ErrorType.TRANSIENT_TIMEOUT);
    });

    test('ECONNRESET should be TRANSIENT_NETWORK', () => {
      const errorType = classifyError(new Error('ECONNRESET'));
      expect(errorType).toBe(ErrorType.TRANSIENT_NETWORK);
    });

    test('ECONNREFUSED should be TRANSIENT_NETWORK', () => {
      const errorType = classifyError(new Error('ECONNREFUSED'));
      expect(errorType).toBe(ErrorType.TRANSIENT_NETWORK);
    });

    test('EAI_AGAIN should be TRANSIENT_TIMEOUT (matches timeout pattern)', () => {
      const errorType = classifyError(new Error('EAI_AGAIN'));
      expect(errorType).toBe(ErrorType.TRANSIENT_TIMEOUT);
    });

    test('Unknown error should be UNKNOWN', () => {
      const errorType = classifyError(new Error('Some random error'));
      expect(errorType).toBe(ErrorType.UNKNOWN);
    });
  });

  describe('isTransientError', () => {
    test('TRANSIENT_* should return true', () => {
      expect(isTransientError(ErrorType.TRANSIENT_TIMEOUT)).toBe(true);
      expect(isTransientError(ErrorType.TRANSIENT_NETWORK)).toBe(true);
      expect(isTransientError(ErrorType.TRANSIENT_RATE_LIMIT)).toBe(true);
      expect(isTransientError(ErrorType.TRANSIENT_SERVICE_UNAVAILABLE)).toBe(true);
    });

    test('PERMANENT_* should return false', () => {
      expect(isTransientError(ErrorType.PERMANENT_NOT_FOUND)).toBe(false);
      expect(isTransientError(ErrorType.PERMANENT_AUTH)).toBe(false);
      expect(isTransientError(ErrorType.PERMANENT_INVALID_INPUT)).toBe(false);
    });

    test('SYSTEM should return false', () => {
      expect(isTransientError(ErrorType.SYSTEM)).toBe(false);
    });
  });

  describe('isRetryableBashError', () => {
    test('timeout errors should be retryable', () => {
      expect(isRetryableBashError('Connection timed out')).toBe(true);
      expect(isRetryableBashError('Request timed out')).toBe(true);
      expect(isRetryableBashError('ETIMEDOUT')).toBe(true);
    });

    test('network errors should be retryable', () => {
      expect(isRetryableBashError('ECONNRESET')).toBe(true);
      expect(isRetryableBashError('ECONNREFUSED')).toBe(true);
      expect(isRetryableBashError('Network is unreachable')).toBe(true);
    });

    test('rate limit should be retryable', () => {
      expect(isRetryableBashError('429 Too Many Requests')).toBe(true);
    });

    test('permission errors should NOT be retryable', () => {
      expect(isRetryableBashError('Permission denied')).toBe(false);
      expect(isRetryableBashError('EACCES')).toBe(false);
      expect(isRetryableBashError('EPERM')).toBe(false);
    });

    test('file not found should NOT be retryable', () => {
      expect(isRetryableBashError('ENOENT: no such file or directory')).toBe(false);
    });
  });

  describe('getErrorDescription', () => {
    test('should return human-readable descriptions', () => {
      expect(getErrorDescription(ErrorType.TRANSIENT_TIMEOUT)).toBe('Request timed out');
      expect(getErrorDescription(ErrorType.TRANSIENT_NETWORK)).toBe('Network connection failed');
      expect(getErrorDescription(ErrorType.TRANSIENT_RATE_LIMIT)).toBe('Rate limit exceeded');
      expect(getErrorDescription(ErrorType.TRANSIENT_SERVICE_UNAVAILABLE)).toBe('Service temporarily unavailable');
      expect(getErrorDescription(ErrorType.PERMANENT_NOT_FOUND)).toBe('Resource not found');
      expect(getErrorDescription(ErrorType.PERMANENT_AUTH)).toBe('Authentication failed');
      expect(getErrorDescription(ErrorType.PERMANENT_FORBIDDEN)).toBe('Access forbidden');
      expect(getErrorDescription(ErrorType.PERMANENT_INVALID_INPUT)).toBe('Invalid input provided');
      expect(getErrorDescription(ErrorType.SYSTEM)).toBe('System error');
      expect(getErrorDescription(ErrorType.UNKNOWN)).toBe('Unknown error');
    });
  });
});
