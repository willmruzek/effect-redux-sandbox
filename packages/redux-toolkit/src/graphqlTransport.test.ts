import {
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { createGraphqlTransport } from './graphqlTransport.js';

describe('GraphQL transport', () => {
  test('sends the operation and variables using its configured endpoint', async () => {
    // Arrange: configure a transport with a recorded HTTP boundary.
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => Response.json({ data: { task: { id: '1' } } }),
    );
    const transport = createGraphqlTransport({
      endpoint: '/graphql',
      fetcher,
      headers: { authorization: 'Bearer test' },
    });

    // Act: execute a defined operation.
    const receipt = await transport({
      document: 'query Task($id: ID!) { task(id: $id) { id } }',
      operationName: 'Task',
      variables: { id: '1' },
      signal: new AbortController().signal,
    });

    // Assert: the endpoint receives the GraphQL request and returns its data.
    expect(fetcher).toHaveBeenCalledOnce();
    const call = fetcher.mock.calls[0];
    if (!call)
      throw new Error('Expected the GraphQL transport to call fetch.');

    const [url, init] = call;
    expect(url).toBe('/graphql');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'query Task($id: ID!) { task(id: $id) { id } }',
      operationName: 'Task',
      variables: { id: '1' },
    });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test');
    expect(receipt.status).toBe('received');
    if (receipt.status === 'received')
      await expect(receipt.read()).resolves.toEqual({ task: { id: '1' } });
  });

  test('rejects partial data when the response contains GraphQL errors', async () => {
    // Arrange: the server returns partial data alongside an operation error.
    const transport = createGraphqlTransport({
      endpoint: '/graphql',
      fetcher: async () => Response.json({
        data: { task: null },
        errors: [{ message: 'Task unavailable' }],
      }),
    });

    // Act: receive the response.
    const receipt = await transport({
      document: 'query Task { task { id } }',
      variables: {},
      signal: new AbortController().signal,
    });

    // Assert: the successful HTTP receipt does not accept partial GraphQL data.
    expect(receipt.status).toBe('received');
    if (receipt.status === 'received')
      await expect(receipt.read()).rejects.toThrow('Task unavailable');
  });

  test('reports an uncertain failure when an HTTP request fails', async () => {
    // Arrange: the server responds with an error after receiving the request.
    const transport = createGraphqlTransport({
      endpoint: '/graphql',
      fetcher: async () => new Response(null, { status: 503 }),
    });

    // Act: submit the operation.
    const receipt = await transport({
      document: 'mutation Save { save }',
      variables: {},
      signal: new AbortController().signal,
    });

    // Assert: status and server uncertainty remain observable.
    expect(receipt.status).toBe('failed');
    if (receipt.status === 'failed') {
      expect(receipt.error.message).toBe('GraphQL request failed (503).');
      expect(receipt.serverMayHaveCommitted).toBe(true);
    }
  });

  test('reports a certain failure when request headers cannot be constructed', async () => {
    // Arrange: the invalid header name prevents any network request.
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const transport = createGraphqlTransport({ endpoint: '/graphql', fetcher });

    // Act: prepare the invalid request.
    const receipt = await transport({
      document: 'mutation Save { save }',
      variables: {},
      headers: { 'invalid header': 'value' },
      signal: new AbortController().signal,
    });

    // Assert: the failure is certain and fetch was never invoked.
    expect(fetcher).not.toHaveBeenCalled();
    expect(receipt.status).toBe('failed');
    if (receipt.status === 'failed')
      expect(receipt.serverMayHaveCommitted).toBe(false);
  });
});
