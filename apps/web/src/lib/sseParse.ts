/**
 * Incremental SSE parser (issue #748).
 *
 * Implements the WHATWG event-stream line/field algorithm so campaign-event
 * clients survive CRLF framing, proxy comment heartbeats, multiline `data:`
 * fields, and TCP/HTTP chunk boundaries (including mid-delimiter and mid-UTF-8
 * splits). Malformed streams that never emit a blank line are bounded; recovery
 * resets in-progress buffers (preserving stream-level `id`/`retry`) and surfaces
 * a `recovered` signal to the caller.
 */
import { utf8ByteLength } from './sseUtf8';

export interface SseMessage {
  /** Event type field; empty string means the default "message" type. */
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
}

export type SseParseSignal =
  | { kind: 'message'; message: SseMessage }
  | { kind: 'recovered'; discardedBytes: number };

export interface SseParserOptions {
  /**
   * Max unfinished decoded text (incomplete line / frame overhead) in **UTF-8
   * bytes** before recovery. Does **not** include an in-progress message's
   * assembled `data` fields — those use {@link maxMessageBytes}. Default 256 KiB.
   */
  maxBufferedBytes?: number;
  /**
   * Max **UTF-8 bytes** for in-progress message field buffers (`data` + `event`)
   * before recovery. Allows a single legitimate large SSE payload while still
   * bounding runaway streams that never send a blank-line delimiter. Default 1 MiB.
   *
   * Stream-level `id` / `retry` are not counted here — they persist across events
   * and across parser recovery.
   */
  maxMessageBytes?: number;
}

export interface SseResetOptions {
  /**
   * When true, keep stream-level `lastEventId` / `retry` (WHATWG reconnect state).
   * Used by buffer-overrun recovery so subsequent messages keep Last-Event-ID
   * continuity. Full connection teardown should call {@link reset} without this.
   */
  preserveStreamState?: boolean;
}

const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export class SseParser {
  private decoder = new TextDecoder('utf-8');
  private readonly maxBufferedBytes: number;
  private readonly maxMessageBytes: number;
  private text = '';
  private dataBuffer = '';
  private eventTypeBuffer = '';
  private lastEventId: string | null = null;
  private retry: number | null = null;

  constructor(options?: SseParserOptions) {
    this.maxBufferedBytes = options?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxMessageBytes = options?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  /** Unfinished frame text waiting for a line terminator (UTF-8 byte length). */
  get unfinishedBytes(): number {
    return utf8ByteLength(this.text);
  }

  /**
   * Assembled field buffers for the in-progress (not yet dispatched) message,
   * measured in UTF-8 bytes. Excludes stream-level `lastEventId` (persists across
   * dispatch / recovery).
   */
  get messageBytes(): number {
    return utf8ByteLength(this.dataBuffer) + utf8ByteLength(this.eventTypeBuffer);
  }

  /** Total pending buffered size (unfinished text + in-progress message fields). */
  get bufferedBytes(): number {
    return this.unfinishedBytes + this.messageBytes;
  }

  /** Feed a raw byte chunk from the ReadableStream. */
  push(chunk: Uint8Array): SseParseSignal[] {
    if (chunk.byteLength === 0) return [];
    this.text += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /**
   * Feed already-decoded text (tests / callers that own decoding). Does not
   * touch the TextDecoder — use {@link flush} / {@link push} for byte streams.
   */
  pushText(text: string): SseParseSignal[] {
    if (text.length === 0) return [];
    this.text += text;
    return this.drain(false);
  }

  /**
   * End of stream: flush the TextDecoder (completing any partial UTF-8 sequence)
   * and finish any line that ends with a dangling CR. Incomplete events without
   * a terminating blank line are discarded per the SSE spec.
   */
  flush(): SseParseSignal[] {
    this.text += this.decoder.decode();
    return this.drain(true);
  }

  /**
   * Reset buffers. By default clears stream-level `id`/`retry` as well (full
   * teardown). Pass `{ preserveStreamState: true }` for mid-stream recovery.
   */
  reset(options?: SseResetOptions): void {
    this.text = '';
    this.dataBuffer = '';
    this.eventTypeBuffer = '';
    if (!options?.preserveStreamState) {
      this.lastEventId = null;
      this.retry = null;
    }
  }

  private drain(flushing: boolean): SseParseSignal[] {
    const out: SseParseSignal[] = [];
    this.processLines(flushing, out);
    // Two separate caps: unfinished line text (malformed never-ending line) vs
    // in-progress message fields (legitimate large payloads use the higher cap).
    if (this.unfinishedBytes > this.maxBufferedBytes || this.messageBytes > this.maxMessageBytes) {
      const discardedBytes = this.bufferedBytes;
      // Keep Last-Event-ID / retry — recovery stays on the same connection.
      this.reset({ preserveStreamState: true });
      // Fresh decoder so a partial UTF-8 sequence can't leak into the next frame.
      this.decoder = new TextDecoder('utf-8');
      out.push({ kind: 'recovered', discardedBytes });
    }
    return out;
  }

  private processLines(flushing: boolean, out: SseParseSignal[]): void {
    let i = 0;
    while (i < this.text.length) {
      let j = i;
      let found = false;
      while (j < this.text.length) {
        const ch = this.text.charCodeAt(j);
        if (ch === 0x0a) {
          // LF
          this.handleLine(this.text.slice(i, j), out);
          i = j + 1;
          found = true;
          break;
        }
        if (ch === 0x0d) {
          // CR — may be CRLF. If this is the last buffered char and more bytes
          // may arrive, hold so a following LF is paired correctly.
          if (j + 1 === this.text.length && !flushing) {
            this.text = this.text.slice(i);
            return;
          }
          this.handleLine(this.text.slice(i, j), out);
          if (j + 1 < this.text.length && this.text.charCodeAt(j + 1) === 0x0a) {
            i = j + 2;
          } else {
            i = j + 1;
          }
          found = true;
          break;
        }
        j += 1;
      }
      if (!found) {
        // No line terminator in the remainder — keep it for the next chunk.
        this.text = this.text.slice(i);
        return;
      }
    }
    this.text = '';
  }

  private handleLine(line: string, out: SseParseSignal[]): void {
    if (line.length === 0) {
      this.dispatch(out);
      return;
    }
    if (line.charCodeAt(0) === 0x3a /* ':' */) {
      // Comment / proxy heartbeat — ignored.
      return;
    }

    let field: string;
    let value: string;
    const colon = line.indexOf(':');
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    }

    switch (field) {
      case 'data':
        this.dataBuffer += value;
        this.dataBuffer += '\n';
        break;
      case 'event':
        this.eventTypeBuffer = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value;
        break;
      case 'retry': {
        if (/^\d+$/.test(value)) this.retry = Number.parseInt(value, 10);
        break;
      }
      default:
        break;
    }
  }

  private dispatch(out: SseParseSignal[]): void {
    if (this.dataBuffer.length === 0) {
      this.eventTypeBuffer = '';
      return;
    }
    let data = this.dataBuffer;
    if (data.charCodeAt(data.length - 1) === 0x0a) {
      data = data.slice(0, -1);
    }
    out.push({
      kind: 'message',
      message: {
        event: this.eventTypeBuffer,
        data,
        id: this.lastEventId,
        retry: this.retry,
      },
    });
    this.dataBuffer = '';
    this.eventTypeBuffer = '';
  }
}

/**
 * Convenience: parse a complete SSE byte/text stream into messages (tests /
 * one-shot helpers). Equivalent to push* + flush on a fresh parser.
 */
export function parseSseText(text: string, options?: SseParserOptions): SseParseSignal[] {
  const parser = new SseParser(options);
  const signals = parser.pushText(text);
  signals.push(...parser.flush());
  return signals;
}
