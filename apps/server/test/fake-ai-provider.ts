import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeAiProviderCall {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

export interface FakeAiProvider {
  baseUrl: string;
  calls: FakeAiProviderCall[];
  failNext(status: number, body: string): void;
  close(): Promise<void>;
}

/**
 * Tiny in-process OpenAI-compatible provider for config integration tests. It
 * records the actual target/model/auth header while keeping every test offline.
 */
export async function startFakeAiProvider(): Promise<FakeAiProvider> {
  const calls: FakeAiProviderCall[] = [];
  let nextFailure: { status: number; body: string } | null = null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // The real adapter always sends JSON; retaining {} makes a malformed call
        // visible to assertions without crashing the fake server.
      }
      calls.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });

      if (nextFailure) {
        const failure = nextFailure;
        nextFailure = null;
        res.writeHead(failure.status, { 'content-type': 'application/json' });
        res.end(failure.body);
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: body.model ?? 'fake-model',
        choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    failNext(status, body) {
      nextFailure = { status, body };
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}
