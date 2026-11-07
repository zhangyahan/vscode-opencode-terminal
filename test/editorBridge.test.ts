import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket, type ClientOptions } from 'ws';

import {
  EDITOR_PROTOCOL_VERSION,
  EDITOR_SERVER_NAME,
  EditorBridge,
} from '../src/editorBridge';

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

function openClient(
  port: number,
  options: ClientOptions = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, options);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out opening WebSocket client.'));
    }, 2_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function nextMessage(socket: WebSocket): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for a WebSocket message.'));
    }, 2_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as JsonRpcMessage);
    });
  });
}

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${label}.`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 2_000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function initializeMessage(id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: EDITOR_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'opencode', version: '0.0.0' },
    },
  });
}

async function handshake(bridge: EditorBridge): Promise<WebSocket> {
  assert.ok(bridge.port, 'bridge must expose a port after start');
  const socket = await openClient(bridge.port);
  const response = nextMessage(socket);
  socket.send(initializeMessage());
  const message = await response;
  assert.equal(message.jsonrpc, '2.0');
  assert.equal(message.id, 1);
  socket.send(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  );
  await waitFor(() => bridge.isReady(), 'initialized handshake');
  return socket;
}

test('real WebSocket client completes initialize/initialized then receives at_mentioned', async () => {
  const bridge = new EditorBridge();
  let socket: WebSocket | undefined;
  try {
    const port = await bridge.start();
    assert.ok(port > 0);
    assert.equal(bridge.port, port);

    socket = await openClient(port);
    const responsePromise = nextMessage(socket);
    socket.send(initializeMessage());
    const response = await responsePromise;
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    const result = response.result as {
      protocolVersion?: string;
      capabilities?: Record<string, unknown>;
      serverInfo?: { name?: string; version?: string };
    };
    assert.equal(result.protocolVersion, EDITOR_PROTOCOL_VERSION);
    assert.deepEqual(result.capabilities, {});
    assert.equal(result.serverInfo?.name, EDITOR_SERVER_NAME);
    assert.equal(JSON.stringify(result).includes('SSE_PORT'), false);
    assert.equal(JSON.stringify(result).includes('editor-port'), false);

    // initialize response alone is not enough; the TUI must send initialized.
    assert.equal(bridge.isReady(), false);
    const beforeInitialized = bridge.sendMention({
      filePath: 'C:/demo/src/a.ts',
      lineStart: 10,
      lineEnd: 12,
    });
    assert.equal(beforeInitialized.ok, false);

    socket.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    await waitFor(() => bridge.isReady(), 'initialized handshake');

    const mentionPromise = nextMessage(socket);
    const sent = bridge.sendMention({
      filePath: 'C:/demo/src/a.ts',
      lineStart: 10,
      lineEnd: 12,
    });
    assert.deepEqual(sent, { ok: true });
    const mention = await mentionPromise;
    assert.equal(mention.jsonrpc, '2.0');
    assert.equal(mention.method, 'at_mentioned');
    assert.deepEqual(mention.params, {
      filePath: 'C:/demo/src/a.ts',
      lineStart: 10,
      lineEnd: 12,
    });
  } finally {
    socket?.terminate();
    await bridge.stop();
  }
});

test('a disconnect makes sendMention fail until a new handshake completes', async () => {
  const bridge = new EditorBridge();
  try {
    await bridge.start();
    const first = await handshake(bridge);
    first.close();
    await waitFor(() => !bridge.isReady(), 'disconnect');
    const result = bridge.sendMention({
      filePath: 'C:/demo/src/a.ts',
      lineStart: 1,
      lineEnd: 2,
    });
    assert.equal(result.ok, false);

    const second = await handshake(bridge);
    assert.equal(bridge.isReady(), true);
    const message = nextMessage(second);
    assert.deepEqual(
      bridge.sendMention({
        filePath: 'C:/demo/src/b.ts',
        lineStart: 3,
        lineEnd: 4,
      }),
      { ok: true },
    );
    assert.equal((await message).method, 'at_mentioned');
    second.terminate();
  } finally {
    await bridge.stop();
  }
});

test('a new connection replaces the old one instead of broadcasting to both', async () => {
  const bridge = new EditorBridge();
  let first: WebSocket | undefined;
  let second: WebSocket | undefined;
  try {
    await bridge.start();
    first = await handshake(bridge);
    second = await handshake(bridge);
    await waitFor(() => first!.readyState === WebSocket.CLOSED, 'old connection closed');
    assert.equal(bridge.isReady(), true);

    const message = nextMessage(second);
    assert.deepEqual(
      bridge.sendMention({
        filePath: 'C:/demo/src/new.ts',
        lineStart: 5,
        lineEnd: 8,
      }),
      { ok: true },
    );
    const mention = await message;
    assert.equal(mention.method, 'at_mentioned');
    assert.equal((mention.params as { filePath?: string }).filePath, 'C:/demo/src/new.ts');
  } finally {
    first?.terminate();
    second?.terminate();
    await bridge.stop();
  }
});

test('browser Origin and non-opencode initialize requests are rejected', async () => {
  const bridge = new EditorBridge();
  try {
    const port = await bridge.start();

    const originClient = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'http://example.com',
    });
    await new Promise<void>((resolve) => {
      originClient.once('unexpected-response', () => resolve());
      originClient.once('error', () => resolve());
      originClient.once('open', () => resolve());
      originClient.once('close', () => resolve());
    });
    originClient.terminate();
    assert.equal(bridge.isReady(), false);

    const invalidClient = await openClient(port);
    const closed = waitForClose(invalidClient);
    invalidClient.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: EDITOR_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'not-opencode', version: '1.0.0' },
        },
      }),
    );
    await closed;
    assert.equal(bridge.isReady(), false);

    const invalidJson = await openClient(port);
    const invalidJsonClosed = waitForClose(invalidJson);
    invalidJson.send('{not json');
    await invalidJsonClosed;
    assert.equal(bridge.isReady(), false);

    const result = bridge.sendMention({
      filePath: 'C:/demo/src/a.ts',
      lineStart: 1,
      lineEnd: 2,
    });
    assert.equal(result.ok, false);
    invalidJson.terminate();
  } finally {
    await bridge.stop();
  }
});

test('stop closes the listener and rejects later sends', async () => {
  const bridge = new EditorBridge();
  const port = await bridge.start();
  const socket = await handshake(bridge);
  assert.equal(bridge.isReady(), true);

  await bridge.stop();
  assert.equal(bridge.isReady(), false);
  const result = bridge.sendMention({
    filePath: 'C:/demo/src/a.ts',
    lineStart: 1,
    lineEnd: 2,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'disposed');
  }
  await waitForClose(socket);
  await assert.rejects(openClient(port), /ECONNREFUSED|connect/i);
  socket.terminate();
});
