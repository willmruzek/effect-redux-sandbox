import {
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { createRestTransport } from './restTransport.js';

describe('REST transport', () => {
  test('builds a JSON request when parameters include falsy values', async () => {
    // Arrange: configure a transport with a recorded HTTP boundary.
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => Response.json({ saved: true }),
    );
    const transport = createRestTransport({
      basePath: '/api/',
      fetcher,
      headers: { authorization: 'Bearer test' },
    });

    // Act: submit a JSON mutation.
    const receipt = await transport({
      path: '/tasks',
      method: 'PATCH',
      query: { search: '', count: 0, active: false, ignored: undefined },
      body: { title: 'Updated' },
      headers: { 'x-operation': 'update' },
      response: 'json',
      signal: new AbortController().signal,
    });

    // Assert: request construction preserves explicit values and headers.
    expect(fetcher).toHaveBeenCalledOnce();
    const call = fetcher.mock.calls[0];

    if (!call)
      throw new Error('Expected the REST transport to call fetch.');

    const [url, init] = call;
    expect(url).toBe('/api/tasks?search=&count=0&active=false');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"title":"Updated"}');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).get('x-operation')).toBe('update');
    expect(receipt.status).toBe('received');
    if (receipt.status === 'received')
      await expect(receipt.read()).resolves.toEqual({ saved: true });
  });

  test('retains the successful receipt when JSON decoding fails', async () => {
    // Arrange: the server acknowledges the request with malformed JSON.
    const transport = createRestTransport({
      basePath: '/api',
      fetcher: async () => new Response('{', { status: 200 }),
    });

    // Act: receive the response without reading its body.
    const receipt = await transport({
      path: 'tasks',
      method: 'POST',
      response: 'json',
      signal: new AbortController().signal,
    });

    // Assert: body parsing fails after, not before, the success boundary.
    expect(receipt.status).toBe('received');
    if (receipt.status === 'received')
      await expect(receipt.read()).rejects.toThrow(SyntaxError);
  });

  test('accepts an empty body when the operation declares an empty response', async () => {
    // Arrange: the server returns no response content.
    const transport = createRestTransport({
      basePath: '/api',
      fetcher: async () => new Response(null, { status: 204 }),
    });

    // Act: receive the explicit empty response.
    const receipt = await transport({
      path: 'tasks/1',
      method: 'DELETE',
      response: 'empty',
      signal: new AbortController().signal,
    });

    // Assert: the deferred reader produces no value.
    expect(receipt.status).toBe('received');
    if (receipt.status === 'received')
      await expect(receipt.read()).resolves.toBeUndefined();
  });

  test('reports an uncertain failure when the server rejects the request', async () => {
    // Arrange: a server error does not prove that no write occurred.
    const transport = createRestTransport({
      basePath: '/api',
      fetcher: async () => new Response(null, { status: 503, statusText: 'Unavailable' }),
    });

    // Act: submit the mutation.
    const receipt = await transport({
      path: 'tasks',
      method: 'POST',
      response: 'json',
      signal: new AbortController().signal,
    });

    // Assert: the failure includes the HTTP status and uncertainty.
    expect(receipt.status).toBe('failed');
    if (receipt.status === 'failed') {
      expect(receipt.error.message).toBe('REST request failed (503 Unavailable).');
      expect(receipt.serverMayHaveCommitted).toBe(true);
    }
  });

  test('preserves the server error message when a JSON request is rejected', async () => {
    // Arrange: the server returns a domain validation error.
    const transport = createRestTransport({
      basePath: '/api',
      fetcher: async () => Response.json({ error: 'Task title is invalid.' }, { status: 400 }),
    });

    // Act: submit the rejected mutation.
    const receipt = await transport({
      path: 'tasks',
      method: 'PATCH',
      response: 'json',
      signal: new AbortController().signal,
    });

    // Assert: both HTTP status and the domain message remain observable.
    expect(receipt.status).toBe('failed');
    if (receipt.status === 'failed') {
      expect(receipt.error.message).toContain('400');
      expect(receipt.error.message).toContain('Task title is invalid.');
      expect(receipt.serverMayHaveCommitted).toBe(true);
    }
  });

  test('reports a malformed JSON error body alongside the HTTP status', async () => {
    // Arrange: the server rejects the request with an invalid JSON error body.
    const transport = createRestTransport({
      basePath: '/api',
      fetcher: async () => new Response('{', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    });

    // Act: submit the mutation.
    const receipt = await transport({
      path: 'tasks',
      method: 'PATCH',
      response: 'json',
      signal: new AbortController().signal,
    });

    // Assert: both the HTTP failure and the unreadable error body are reported.
    expect(receipt.status).toBe('failed');
    if (receipt.status === 'failed') {
      expect(receipt.error.message).toContain('500');
      expect(receipt.error.message).toContain('Invalid JSON error response');
      expect(receipt.serverMayHaveCommitted).toBe(true);
    }
  });

  test('reports a certain failure when JSON serialization prevents transport', async () => {
    // Arrange: the JSON body contains a cycle and cannot be sent.
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const transport = createRestTransport({ basePath: '/api', fetcher });
    const body: { self?: object } = {};
    body.self = body;

    // Act: attempt to submit the invalid body.
    const receipt = await transport({
      path: 'tasks',
      method: 'POST',
      body,
      response: 'json',
      signal: new AbortController().signal,
    });

    // Assert: the server cannot have committed a request that was never sent.
    expect(fetcher).not.toHaveBeenCalled();
    expect(receipt.status).toBe('failed');
    if (receipt.status === 'failed')
      expect(receipt.serverMayHaveCommitted).toBe(false);
  });

  test('reports an uncertain failure when the network rejects the request', async () => {
    // Arrange: the network fails after the request reaches the transport.
    const transport = createRestTransport({
      basePath: '/api',
      fetcher: async () => { throw new Error('Connection lost'); },
    });

    // Act: submit the mutation.
    const receipt = await transport({
      path: 'tasks',
      method: 'POST',
      response: 'json',
      signal: new AbortController().signal,
    });

    // Assert: the original failure and uncertainty remain observable.
    expect(receipt.status).toBe('failed');
    if (receipt.status === 'failed') {
      expect(receipt.error.message).toBe('Connection lost');
      expect(receipt.serverMayHaveCommitted).toBe(true);
    }
  });

  test('rejects an empty body when the operation expects JSON', async () => {
    // Arrange: an operation expects JSON but the server responds without it.
    const transport = createRestTransport({
      basePath: '/api',
      fetcher: async () => new Response(null, { status: 204 }),
    });

    // Act: receive the response.
    const receipt = await transport({
      path: 'tasks/1',
      method: 'GET',
      response: 'json',
      signal: new AbortController().signal,
    });

    // Assert: parsing fails after the successful response is acknowledged.
    expect(receipt.status).toBe('received');
    if (receipt.status === 'received')
      await expect(receipt.read()).rejects.toThrow(SyntaxError);
  });

  test('reports a certain failure when request headers cannot be constructed', async () => {
    // Arrange: the invalid header name prevents any network request.
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const transport = createRestTransport({ basePath: '/api', fetcher });

    // Act: prepare the invalid request.
    const receipt = await transport({
      path: 'tasks',
      method: 'POST',
      headers: { 'invalid header': 'value' },
      response: 'json',
      signal: new AbortController().signal,
    });

    // Assert: the failure is certain and fetch was never invoked.
    expect(fetcher).not.toHaveBeenCalled();
    expect(receipt.status).toBe('failed');
    if (receipt.status === 'failed')
      expect(receipt.serverMayHaveCommitted).toBe(false);
  });
});
