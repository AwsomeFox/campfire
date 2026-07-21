/**
 * Shared test helpers for the AI provider adapters (#309). NOT a spec itself (no `describe`),
 * so jest's testRegex ignores it — it is imported by the provider specs. Everything here is
 * offline: fake `fetch` implementations return canned JSON or a canned SSE byte stream, so no
 * adapter test ever touches the network.
 */

import type { FetchLike, FetchResponse } from '../../src/modules/ai-dm/providers/http';

/** Build a fake JSON `FetchResponse` (2xx). */
export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): FetchResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
    body: null,
  };
}

/** Build a fake error `FetchResponse` with a raw text body. */
export function errorResponse(status: number, bodyText = '', headers: Record<string, string> = {}): FetchResponse {
  return {
    ok: false,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText || '{}'),
    body: null,
  };
}

/** Turn SSE frames into a byte `ReadableStream`, splitting mid-frame to exercise the buffer. */
export function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue = chunks.map((c) => encoder.encode(c));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < queue.length) controller.enqueue(queue[i++]);
      else controller.close();
    },
  });
}

/** Build a fake streaming `FetchResponse` from raw SSE text chunks. */
export function streamResponse(chunks: string[], status = 200): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => chunks.join(''),
    json: async () => ({}),
    body: sseStream(chunks),
  };
}

/** A fake fetch that returns a fixed response and records the calls it received. */
export function fakeFetch(response: FetchResponse | ((url: string, init: Parameters<FetchLike>[1]) => FetchResponse)): {
  fetchImpl: FetchLike;
  calls: { url: string; init: Parameters<FetchLike>[1] }[];
} {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { fetchImpl, calls };
}

/** A fake fetch that returns a different response per call, in sequence. */
export function sequenceFetch(responses: FetchResponse[]): { fetchImpl: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
  return { fetchImpl, calls };
}

/** Collect all events from an async iterable into an array. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** Parse the JSON body sent on a recorded fetch call. */
export function sentBody(init: Parameters<FetchLike>[1]): Record<string, unknown> {
  return JSON.parse(init.body ?? '{}');
}
