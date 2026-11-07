/**
 * Loopback WebSocket bridge for OpenCode's internal editor integration.
 *
 * This implements the protocol consumed by OpenCode's TUI (dev branch,
 * `packages/tui/src/context/editor.ts`):
 *
 * 1. The TUI connects to `ws://127.0.0.1:<port>` using the port from
 *    `CLAUDE_CODE_SSE_PORT` or `OPENCODE_EDITOR_SSE_PORT`.
 * 2. It sends a JSON-RPC `initialize` request with protocol version
 *    `2025-11-25`.
 * 3. We answer with a valid JSON-RPC result (empty capabilities, constant
 *    serverInfo), then the TUI sends `notifications/initialized`.
 * 4. Only after that handshake do we send `at_mentioned` notifications. The
 *    TUI turns them into `insertFileMention` -> `insertPart`, without pressing
 *    Return/Tab.
 *
 * The protocol has no acknowledgement. `sendMention` returning ok means the
 * frame was handed to the socket, not that the TUI inserted it.
 */

import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

export const EDITOR_PROTOCOL_VERSION = '2025-11-25';
export const MAX_EDITOR_MESSAGE_BYTES = 64 * 1024;
export const MAX_EDITOR_CLIENTS = 1;
export const HANDSHAKE_TIMEOUT_MS = 5_000;
export const EDITOR_SERVER_NAME = 'vscode-opencode-terminal';
export const EDITOR_SERVER_VERSION = '0.0.8';

export interface EditorMentionParams {
  readonly filePath: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export type EditorMentionFailureReason =
  | 'not-ready'
  | 'disconnected'
  | 'invalid'
  | 'disposed';

export type EditorMentionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: EditorMentionFailureReason;
      readonly message: string;
    };

/** Injectable subset used by the extension host and integration tests. */
export interface EditorBridgeLike {
  readonly port: number | undefined;
  start(): Promise<number>;
  stop(): Promise<void>;
  isReady(): boolean;
  sendMention(params: EditorMentionParams): EditorMentionResult;
}

type BridgeState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function validPort(port: number | undefined): port is number {
  return (
    port !== undefined &&
    Number.isSafeInteger(port) &&
    port > 0 &&
    port <= 65535
  );
}

function toText(data: RawData): string | undefined {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return undefined;
}

function isValidMention(params: EditorMentionParams): boolean {
  return (
    typeof params.filePath === 'string' &&
    params.filePath.length > 0 &&
    params.filePath.length <= 4096 &&
    !CONTROL_CHARACTERS.test(params.filePath) &&
    Number.isSafeInteger(params.lineStart) &&
    params.lineStart >= 1 &&
    Number.isSafeInteger(params.lineEnd) &&
    params.lineEnd >= params.lineStart &&
    params.lineEnd <= 10_000_000
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    timer.unref?.();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function closeHttpServer(server: Server | undefined): Promise<void> {
  if (server === undefined) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
      server.closeAllConnections?.();
    } catch {
      resolve();
    }
  });
}

function closeWebSocketServer(server: WebSocketServer | undefined): Promise<void> {
  if (server === undefined) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
      for (const client of server.clients) {
        try {
          client.terminate();
        } catch {
          // Already closed.
        }
      }
    } catch {
      resolve();
    }
  });
}

/**
 * Owns one loopback TCP listener and at most one handshaken TUI connection.
 * A reconnect replaces the previous connection; nothing is queued or replayed.
 */
export class EditorBridge implements EditorBridgeLike {
  private httpServer: Server | undefined;
  private wss: WebSocketServer | undefined;
  private socket: WebSocket | undefined;
  private readonly clients = new Set<WebSocket>();
  private portValue: number | undefined;
  private state: BridgeState = 'idle';
  private startPromise: Promise<number> | undefined;
  private stopPromise: Promise<void> | undefined;
  private ready = false;
  private initializeRequested = false;
  private handshakeTimer: NodeJS.Timeout | undefined;

  get port(): number | undefined {
    return this.portValue;
  }

  isReady(): boolean {
    return (
      this.state === 'running' &&
      this.ready &&
      this.socket !== undefined &&
      this.socket.readyState === WebSocket.OPEN
    );
  }

  async start(): Promise<number> {
    if (this.state === 'running' && validPort(this.portValue)) {
      return this.portValue;
    }
    if (this.state === 'starting' && this.startPromise !== undefined) {
      return this.startPromise;
    }
    if (this.state === 'stopping' || this.state === 'stopped') {
      throw new Error('Editor bridge has already been stopped.');
    }

    this.state = 'starting';
    this.startPromise = this.listen();
    try {
      const port = await this.startPromise;
      if ((this.state as BridgeState) !== 'running') {
        throw new Error('Editor bridge was stopped during startup.');
      }
      return port;
    } catch (error) {
      if (this.state === 'starting') {
        this.state = 'stopped';
        await this.closeResources();
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' && this.stopPromise === undefined) {
      return;
    }
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    this.state = 'stopping';
    const pendingStart = this.startPromise;
    this.stopPromise = (async () => {
      if (pendingStart !== undefined) {
        try {
          await pendingStart;
        } catch {
          // Startup failed or was aborted; close whatever was created.
        }
      }
      await this.closeResources();
    })();
    await this.stopPromise;
    this.state = 'stopped';
  }

  sendMention(params: EditorMentionParams): EditorMentionResult {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return {
        ok: false,
        reason: 'disposed',
        message: 'Editor bridge is stopped.',
      };
    }
    if (!isValidMention(params)) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'Editor mention parameters are invalid.',
      };
    }
    if (!this.isReady()) {
      return {
        ok: false,
        reason: this.socket === undefined ? 'disconnected' : 'not-ready',
        message: 'Editor bridge is not ready; no mention was sent.',
      };
    }

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'at_mentioned',
      params: {
        filePath: params.filePath,
        lineStart: params.lineStart,
        lineEnd: params.lineEnd,
      },
    });
    if (Buffer.byteLength(payload, 'utf8') > MAX_EDITOR_MESSAGE_BYTES) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'Editor mention message exceeds the size limit.',
      };
    }

    try {
      this.socket!.send(payload);
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: 'disconnected',
        message: 'Editor bridge socket closed before the mention was sent.',
      };
    }
  }

  private async listen(): Promise<number> {
    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    this.httpServer = server;

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_EDITOR_MESSAGE_BYTES,
      perMessageDeflate: false,
      clientTracking: true,
    });
    this.wss = wss;

    server.on('upgrade', (request, socket, head) => {
      if (this.state !== 'starting' && this.state !== 'running') {
        socket.destroy();
        return;
      }
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        socket.destroy();
        return;
      }
      // Node's editor client sends no Origin. Any browser-style Origin is
      // rejected so a web page cannot drive the bridge through loopback.
      if (request.headers.origin !== undefined) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      if (this.socket === undefined && this.clients.size >= MAX_EDITOR_CLIENTS) {
        socket.destroy();
        return;
      }
      if (this.socket !== undefined) {
        // Keep at most one handshaken client. A reconnect replaces the old
        // connection; nothing is replayed to the new one.
        this.dropConnection(4000, 'Replaced by a newer editor connection.');
      }

      wss.handleUpgrade(request, socket, head, (client) => {
        this.attachClient(client);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Editor bridge did not receive a loopback TCP port.');
    }
    this.portValue = address.port;
    if (this.state !== 'starting') {
      // stop() was requested while listen() was in flight.
      throw new Error('Editor bridge was stopped during startup.');
    }
    this.state = 'running';
    return address.port;
  }

  private attachClient(client: WebSocket): void {
    if (this.state !== 'running') {
      client.terminate();
      return;
    }

    this.socket = client;
    this.clients.add(client);
    this.ready = false;
    this.initializeRequested = false;
    this.clearHandshakeTimer();

    // A client may take a moment to send initialize; never keep an unfinished
    // handshake forever.
    this.handshakeTimer = setTimeout(() => {
      if (this.socket === client && !this.ready) {
        this.dropConnection(1008, 'Editor handshake timed out.');
      }
    }, HANDSHAKE_TIMEOUT_MS);
    this.handshakeTimer.unref?.();

    client.on('message', (data) => {
      if (this.socket !== client) {
        return;
      }
      this.handleMessage(client, data);
    });
    client.on('error', () => {
      if (this.socket === client) {
        this.clearConnection();
      }
    });
    client.on('close', () => {
      if (this.socket === client) {
        this.clearConnection();
      }
    });
  }

  private handleMessage(client: WebSocket, data: RawData): void {
    const text = toText(data);
    if (text === undefined) {
      this.dropConnection(1007, 'Editor message must be text.');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.dropConnection(1007, 'Invalid JSON editor message.');
      return;
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
      this.dropConnection(1008, 'Invalid JSON-RPC editor message.');
      return;
    }

    const method = parsed.method;
    if (method === 'initialize') {
      this.handleInitialize(client, parsed);
      return;
    }
    if (method === 'notifications/initialized') {
      if (!this.initializeRequested || this.ready) {
        this.dropConnection(1008, 'Unexpected initialized notification.');
        return;
      }
      this.ready = true;
      this.clearHandshakeTimer();
      return;
    }

    // We do not issue requests. Ignore unsolicited responses/notifications
    // instead of treating them as protocol failures.
  }

  private handleInitialize(
    client: WebSocket,
    message: Record<string, unknown>,
  ): void {
    if (this.initializeRequested || this.ready) {
      this.dropConnection(1008, 'Duplicate initialize request.');
      return;
    }

    const id = message.id;
    if (
      !Number.isSafeInteger(id) &&
      !(typeof id === 'string' && id.length > 0) &&
      id !== null
    ) {
      this.dropConnection(1008, 'Initialize request id is invalid.');
      return;
    }

    const params = message.params;
    if (!isRecord(params)) {
      this.dropConnection(1008, 'Initialize params are missing.');
      return;
    }
    const clientInfo = params.clientInfo;
    if (
      params.protocolVersion !== EDITOR_PROTOCOL_VERSION ||
      !isRecord(clientInfo) ||
      clientInfo.name !== 'opencode'
    ) {
      this.dropConnection(1008, 'Unsupported editor initialize request.');
      return;
    }

    this.initializeRequested = true;
    try {
      client.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: EDITOR_PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: {
              name: EDITOR_SERVER_NAME,
              version: EDITOR_SERVER_VERSION,
            },
          },
        }),
      );
    } catch {
      this.dropConnection(1011, 'Failed to send initialize response.');
    }
  }

  private dropConnection(code: number, reason: string): void {
    const client = this.socket;
    this.clearConnection();
    if (client !== undefined) {
      try {
        client.close(code, reason);
      } catch {
        // Already closed.
      }
      try {
        client.terminate();
      } catch {
        // Already closed.
      }
    }
  }

  private clearConnection(): void {
    if (this.socket !== undefined) {
      this.clients.delete(this.socket);
    }
    this.socket = undefined;
    this.ready = false;
    this.initializeRequested = false;
    this.clearHandshakeTimer();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private async closeResources(): Promise<void> {
    this.clearHandshakeTimer();
    this.socket = undefined;
    this.ready = false;
    this.initializeRequested = false;
    for (const client of [...this.clients]) {
      try {
        client.close(1001, 'Editor bridge stopped.');
      } catch {
        // Already closed.
      }
      try {
        client.terminate();
      } catch {
        // Already closed.
      }
    }
    this.clients.clear();

    const wss = this.wss;
    this.wss = undefined;
    const server = this.httpServer;
    this.httpServer = undefined;
    this.portValue = undefined;

    await withTimeout(closeWebSocketServer(wss), 1_000);
    await withTimeout(closeHttpServer(server), 1_000);
  }
}
