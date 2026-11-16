import type { TransportReceipt } from './transport.js';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

type QueryValue = string | number | boolean | null | undefined;

export type RestTransportRequest = {
  readonly path: string;
  readonly method: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly headers?: HeadersInit;
  readonly body?: unknown;
  readonly response: 'json' | 'empty';
  readonly signal: AbortSignal;
};

export function createRestTransport(options: {
  readonly basePath: string;
  readonly headers?: HeadersInit;
  readonly fetcher?: Fetcher;
}): (request: RestTransportRequest) => Promise<TransportReceipt> {
  return async (request) => {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null)
        query.append(key, String(value));
    }

    const base = options.basePath.replace(/\/+$/, '');
    const path = request.path.replace(/^\/+/, '');
    const search = query.toString();
    const url = `${base}/${path}${search ? `?${search}` : ''}`;
    let headers: Headers;
    let body: string | undefined;

    try {
      headers = new Headers(options.headers);

      if (!headers.has('accept'))
        headers.set('accept', 'application/json');
      if (request.body !== undefined && !headers.has('content-type'))
        headers.set('content-type', 'application/json');

      new Headers(request.headers).forEach((value, key) => headers.set(key, value));
      body = request.body === undefined ? undefined : JSON.stringify(request.body);

      if (request.body !== undefined && body === undefined)
        throw new Error('REST request body is not JSON serializable.');
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        serverMayHaveCommitted: false,
      };
    }

    let response: Response;

    try {
      response = await (options.fetcher ?? fetch)(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: request.signal,
      });
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        serverMayHaveCommitted: true,
      };
    }

    if (!response.ok) {
      const status = `${response.status} ${response.statusText}`.trim();
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      let detail = '';

      if (contentType === 'application/json' || contentType?.endsWith('+json')) {
        try {
          const value: unknown = await response.json();

          if (typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string')
            detail = ` ${value.error}`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          detail = ` Invalid JSON error response: ${message}`;
        }
      }

      return {
        status: 'failed',
        error: new Error(`REST request failed (${status}).${detail}`),
        serverMayHaveCommitted: true,
      };
    }

    return {
      status: 'received',
      read: async () => {
        if (request.response === 'empty') {
          const body = await response.text();

          if (body.length)
            throw new Error('Expected an empty REST response.');

          return undefined;
        }

        return response.json();
      },
    };
  };
}
