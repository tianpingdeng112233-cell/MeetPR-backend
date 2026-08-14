import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

import type { Express } from 'express';

export interface InMemoryResponse {
  status: number;
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
  // Match supertest's intentionally loose response-body type in test code.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

class MemorySocket extends Duplex {
  readonly output: Buffer[] = [];

  constructor() {
    super({ allowHalfOpen: true, autoDestroy: false });
  }

  override _read(): void {
    // Request bytes are pushed directly by the injector below.
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
    callback();
  }
}

function responseBody(rawResponse: Buffer): string {
  const separator = rawResponse.indexOf('\r\n\r\n');
  if (separator === -1) return '';
  return rawResponse.subarray(separator + 4).toString('utf8');
}

function execute(
  app: Express,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<InMemoryResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const socket = new MemorySocket();
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const request = new IncomingMessage(socket as unknown as Socket);
    // A directly-constructed IncomingMessage otherwise auto-destroys itself
    // after its body ends. Real HTTP parsers keep the socket alive while async
    // Express middleware produces the response.
    request.destroy = () => request;
    request.method = method;
    request.url = path;
    request.headers = {
      host: 'localhost',
      ...Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
      ),
      ...(payload.length === 0
        ? {}
        : {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          }),
    };

    const response = new ServerResponse(request);
    response.assignSocket(socket as unknown as Socket);
    response.on('error', reject);
    response.on('finish', () => {
      const text = responseBody(Buffer.concat(socket.output));
      let parsedBody: unknown = {};
      if (text.length > 0) {
        const contentType = response.getHeader('content-type');
        parsedBody =
          typeof contentType === 'string' && contentType.includes('application/json')
            ? JSON.parse(text)
            : text;
      }
      resolve({
        status: response.statusCode,
        statusCode: response.statusCode,
        headers: response.getHeaders(),
        text,
        body: parsedBody,
      });
    });

    app(request, response);
    if (payload.length > 0) request.push(payload);
    request.push(null);
  });
}

class InMemoryTest implements PromiseLike<InMemoryResponse> {
  private readonly headers: Record<string, string> = {};
  private requestBody: unknown;
  private promise?: Promise<InMemoryResponse>;

  constructor(
    private readonly app: Express,
    private readonly method: string,
    private readonly path: string,
  ) {}

  set(name: string | Record<string, string>, value?: string): this {
    if (typeof name === 'string') {
      if (value !== undefined) this.headers[name] = value;
    } else {
      Object.assign(this.headers, name);
    }
    return this;
  }

  send(body: unknown): this {
    this.requestBody = body;
    return this;
  }

  then<TResult1 = InMemoryResponse, TResult2 = never>(
    onfulfilled?: ((value: InMemoryResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.promise ??= execute(this.app, this.method, this.path, this.headers, this.requestBody);
    return this.promise.then(onfulfilled, onrejected);
  }
}

export function request(app: Express) {
  return {
    delete: (path: string) => new InMemoryTest(app, 'DELETE', path),
    get: (path: string) => new InMemoryTest(app, 'GET', path),
    patch: (path: string) => new InMemoryTest(app, 'PATCH', path),
    post: (path: string) => new InMemoryTest(app, 'POST', path),
    put: (path: string) => new InMemoryTest(app, 'PUT', path),
  };
}
