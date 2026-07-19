import { describe, expect, test } from 'bun:test';
import { CryptoSession } from '../../src/crypto';
import { CryptoClient } from '../../web/src/lib/crypto';

async function establishSession(client: CryptoClient): Promise<CryptoSession> {
  const server = new CryptoSession();
  const clientPublicKey = await client.generateKeyPair();
  const serverPublicKey = await server.init();
  await server.deriveKey(clientPublicKey);
  await client.deriveKey(serverPublicKey);
  return server;
}

async function expectBidirectionalInterop(client: CryptoClient): Promise<void> {
  const server = await establishSession(client);
  expect(client.ready).toBe(true);

  const fromClient = 'web client -> native server';
  expect(await server.decrypt(await client.encrypt(fromClient))).toBe(fromClient);

  const fromServer = 'native server -> web client';
  expect(await client.decrypt(await server.encrypt(fromServer))).toBe(fromServer);

  client.dispose();
  server.dispose();
  expect(client.ready).toBe(false);
}

describe('web crypto client interoperability', () => {
  test('native Web Crypto backend remains compatible with the server', async () => {
    await expectBidirectionalInterop(new CryptoClient());
  });

  test('pure JavaScript fallback remains compatible with the server', async () => {
    await expectBidirectionalInterop(new CryptoClient({ forceFallback: true }));
  });
});
