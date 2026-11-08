type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON variable identities ignore object property order, never array order. */
export function variablesKey(value: unknown, parents = new Set<object>()): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);

  if (typeof value !== 'object' || value === null || parents.has(value)) {
    throw new Error('GraphQL variables must be acyclic JSON values.');
  }

  const next = new Set(parents).add(value);

  if (Array.isArray(value))
    return `[${Array.from(value, (item: unknown) => variablesKey(item, next)).join(',')}]`;

  if (!isRecord(value))
    throw new Error('GraphQL variables must contain only plain JSON objects.');

  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error('GraphQL variables must contain only plain JSON objects.');
  }

  return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${variablesKey(item, next)}`).join(',')}}`;
}

/** Strict response policy: GraphQL errors, including partial data, never reach normalization. */
export async function requestGraphql(options: {
  readonly endpoint: string;
  readonly document: string;
  readonly operationName?: string;
  readonly variables: object;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
  readonly fetcher?: Fetcher;
}): Promise<unknown> {
  const headers = new Headers(options.headers);

  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/graphql-response+json, application/json');

  const response = await (options.fetcher ?? fetch)(options.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: options.document,
      ...(options.operationName ? { operationName: options.operationName } : {}),
      variables: options.variables,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok)
    throw new Error(`GraphQL request failed (${response.status}).`);

  const body: unknown = await response.json();

  if (!isRecord(body))
    throw new Error('Invalid GraphQL response: missing data.');

  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors) || body.errors.length === 0)
      throw new Error('Invalid GraphQL errors response.');

    const messages = body.errors.map((error: unknown) => {
      if (!isRecord(error) || typeof error.message !== 'string')
        throw new Error('Invalid GraphQL errors response.');

      return error.message;
    });

    throw new Error(messages.join('; '));
  }

  if (!Object.hasOwn(body, 'data'))
    throw new Error('Invalid GraphQL response: missing data.');

  return body.data;
}

