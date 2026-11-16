import { Predicate } from 'effect';

import type { TransportReceipt } from './transport.js';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

type GraphqlTransportRequest = {
  readonly document: string;
  readonly operationName?: string;
  readonly variables: object;
  readonly headers?: HeadersInit;
  readonly signal: AbortSignal;
};

function decodeEnvelope(body: unknown): unknown {
  if (!Predicate.isObject(body))
    throw new Error('Invalid GraphQL response: missing data.');

  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors) || body.errors.length === 0)
      throw new Error('Invalid GraphQL errors response.');

    const messages = body.errors.map((error: unknown) => {
      if (!Predicate.isObject(error) || !Predicate.isString(error.message))
        throw new Error('Invalid GraphQL errors response.');

      return error.message;
    });

    throw new Error(messages.join('; '));
  }

  if (!Object.hasOwn(body, 'data'))
    throw new Error('Invalid GraphQL response: missing data.');

  return body.data;
}

export function createGraphqlTransport(options: {
  readonly endpoint: string;
  readonly headers?: HeadersInit;
  readonly fetcher?: Fetcher;
}): (request: GraphqlTransportRequest) => Promise<TransportReceipt> {
  return async (request) => {
    let headers: Headers;
    let body: string;

    try {
      headers = new Headers(options.headers);

      if (!headers.has('content-type'))
        headers.set('content-type', 'application/json');
      if (!headers.has('accept'))
        headers.set('accept', 'application/graphql-response+json, application/json');

      new Headers(request.headers).forEach((value, key) => headers.set(key, value));
      body = JSON.stringify({
        query: request.document,
        ...(request.operationName ? { operationName: request.operationName } : {}),
        variables: request.variables,
      });
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        serverMayHaveCommitted: false,
      };
    }

    let response: Response;

    try {
      response = await (options.fetcher ?? fetch)(options.endpoint, {
        method: 'POST',
        headers,
        body,
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
      return {
        status: 'failed',
        error: new Error(`GraphQL request failed (${response.status}).`),
        serverMayHaveCommitted: true,
      };
    }

    return {
      status: 'received',
      read: async () => decodeEnvelope(await response.json()),
    };
  };
}
