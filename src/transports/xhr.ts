import type { BaseTransportOptions, Transport, TransportMakeRequestResponse } from '@sentry/core';
import { createTransport } from '@sentry/core';

import { sdk } from '../crossPlatform';

const SENTRY_ENVELOPE_CONTENT_TYPE = 'application/x-sentry-envelope';

export interface MiniappTransportOptions extends BaseTransportOptions {
  /** Custom headers for the request */
  headers?: Record<string, string>;
}

/**
 * Creates a Transport that uses the miniapp request API to send events to Sentry.
 */
export function createMiniappTransport(options: MiniappTransportOptions): Transport {
  // 保存 URL 到局部变量
  const transportUrl = options.url;

  /**
   * Make a request using miniapp request API
   */
  function makeRequest(request: {
    body: string | Uint8Array;
    headers?: Record<string, string>;
  }): Promise<TransportMakeRequestResponse> {
    return new Promise((resolve, reject) => {
      const requestOptions = {
        url: transportUrl,
        method: 'POST' as const,
        data:
          typeof request.body === 'string'
            ? request.body
            : request.body.buffer.slice(
                request.body.byteOffset,
                request.body.byteOffset + request.body.byteLength,
              ),
        header: {
          'Content-Type': SENTRY_ENVELOPE_CONTENT_TYPE,
          ...options.headers,
          ...request.headers,
        },
        // Alipay uses `headers` instead of `header`
        headers: {
          'Content-Type': SENTRY_ENVELOPE_CONTENT_TYPE,
          ...options.headers,
          ...request.headers,
        },
        timeout: 10000,
        success: (res: any) => {
          // Alipay uses `status` instead of `statusCode`, and `headers` instead of `header`
          const status = res.statusCode || res.status;
          const rawHeaders = res.header || res.headers || {};
          const resHeaders = Object.fromEntries(
            Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), value]),
          );

          resolve({
            statusCode: status,
            headers: {
              'x-sentry-rate-limits':
                (resHeaders['x-sentry-rate-limits'] as string | undefined) ?? null,
              'retry-after': (resHeaders['retry-after'] as string | undefined) ?? null,
            },
          });
        },
        fail: (error: any) => {
          reject(
            new Error(
              `Network request failed: ${error.errMsg || error.errorMessage || error.message || 'Unknown error'}`,
            ),
          );
        },
      };

      // Use the appropriate request method based on the platform
      if (sdk().request) {
        sdk().request?.(requestOptions);
      } else if (sdk().httpRequest) {
        sdk().httpRequest?.(requestOptions);
      } else {
        reject(new Error('No request method available in current miniapp environment'));
      }
    });
  }

  return createTransport(options, makeRequest);
}
