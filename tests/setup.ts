process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

import { Server as TlsServer } from 'node:tls';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import supertest from 'supertest';

// Supertest starts a throwaway server per request via `app.listen(0)`, which
// binds the wildcard address. On macOS, SO_REUSEADDR (the libuv default) lets
// that wildcard bind be assigned an ephemeral port that another process
// already holds with a 127.0.0.1-specific listener — the two coexist, and the
// more specific bind wins loopback routing. The test's request to
// 127.0.0.1:<port> is then answered by the unrelated process (e.g. a local
// proxy replying a bare "400 Bad Request"), which surfaced as rare,
// inexplicable 400s across the whole suite (~1 in 10 full runs; a single file
// never cycles enough ports to collide). Binding to 127.0.0.1 makes the kernel
// pick a port that is free on loopback itself (measured: 0 collisions in 20k
// binds vs 1 per ~16k for the wildcard), and a loopback-specific bind can
// never lose its own traffic to a squatter.
//
// A host argument turns listen() into an async bind (address() stays null
// until the dns.lookup tick), while supertest builds its URL synchronously in
// the Test constructor — so the port is patched into the URL in end(), which
// every send path (await/then/expect-callback) funnels through.
const SupertestTest = supertest.Test;

interface PatchedTest {
  url: string;
  _server?: Server;
  _listenError?: Error;
}

SupertestTest.prototype.serverAddress = function (
  this: PatchedTest,
  app: Server,
  path: string,
): string {
  if (!app.address()) {
    const server = app.listen(0, '127.0.0.1');
    this._server = server;
    // The bind is async, so a listen failure would fire 'error' on the next
    // tick — before end() (reached via a promise microtask) can attach a
    // handler — and crash the worker as an unhandled error. Catch it here and
    // let end() surface it to the request callback.
    const onListenError = (err: Error) => {
      this._listenError = err;
    };
    server.once('error', onListenError);
    server.once('listening', () => {
      server.removeListener('error', onListenError);
    });
  }
  const protocol = app instanceof TlsServer ? 'https' : 'http';
  const addr = app.address() as AddressInfo | null;
  return `${protocol}://127.0.0.1:${String(addr ? addr.port : 0)}${path}`;
};

// eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately captured for the monkey-patch; always re-invoked with the Test as `this`.
const originalEnd = SupertestTest.prototype.end;
SupertestTest.prototype.end = function (
  this: PatchedTest,
  fn?: (err: unknown, res: unknown) => void,
) {
  const server = this._server;
  const patchPort = () => {
    const addr = server?.address() as AddressInfo | null;
    if (addr) {
      this.url = this.url.replace(
        /^(https?:\/\/127\.0\.0\.1):0(?=\/|\?|$)/,
        `$1:${String(addr.port)}`,
      );
    }
  };
  if (this._listenError) {
    fn?.(this._listenError, undefined);
    return this;
  }
  if (server && !server.listening) {
    const onListening = () => {
      server.removeListener('error', onError);
      patchPort();
      originalEnd.call(this, fn);
    };
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      fn?.(err, undefined);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    return this;
  }
  patchPort();
  return originalEnd.call(this, fn);
} as typeof originalEnd;
