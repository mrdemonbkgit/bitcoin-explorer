#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import request from 'supertest';

const BITCOIND_PATH = process.env.BITCOIND_PATH || 'bitcoind';
const RPC_PORT = 18443;
const ZMQ_BLOCK_PORT = 28332;
const ZMQ_TX_PORT = 28333;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

async function waitForFile(filePath, attempts = 50, intervalMs = 200) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await readFile(filePath, 'utf8');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      await delay(intervalMs);
    }
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function readCookie(cookiePath) {
  const raw = (await readFile(cookiePath, 'utf8')).trim();
  if (!raw) {
    throw new Error('Cookie file is empty');
  }

  if (raw.includes(':')) {
    const [username, password] = raw.split(':', 2);
    return { username, password };
  }
  return { username: '__cookie__', password: raw };
}

async function rpc({ username, password }, method, params = []) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (payload.error) {
    const error = new Error(payload.error.message || 'RPC error');
    error.name = 'BitcoinRpcError';
    throw Object.assign(error, { code: payload.error.code });
  }
  return payload.result;
}

async function waitForRpc(auth, attempts = 30, intervalMs = 500) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rpc(auth, 'getblockchaininfo');
      return;
    } catch {
      await delay(intervalMs);
    }
  }
  throw new Error('Timed out waiting for bitcoind RPC readiness');
}

async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 500, errorMessage = 'Condition not met in time' }) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error(errorMessage);
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bitcoin-explorer-regtest-'));
  const zmqBlock = `tcp://127.0.0.1:${ZMQ_BLOCK_PORT}`;
  const zmqTx = `tcp://127.0.0.1:${ZMQ_TX_PORT}`;

  let auth;
  let rpcStopped = false;
  let stopZmq = async () => {};

  console.log(`[regtest] Starting bitcoind at ${dataDir}`);
  const bitcoind = spawn(BITCOIND_PATH, [
    `-datadir=${dataDir}`,
    '-regtest=1',
    '-server=1',
    '-txindex=1',
    '-listen=0',
    '-dnsseed=0',
    '-discover=0',
    `-rpcallowip=127.0.0.1`,
    `-rpcbind=127.0.0.1`,
    `-rpcport=${RPC_PORT}`,
    `-zmqpubrawblock=${zmqBlock}`,
    `-zmqpubrawtx=${zmqTx}`,
    '-fallbackfee=0.0001'
  ], {
    stdio: 'ignore'
  });

  bitcoind.on('error', (error) => {
    console.error('[regtest] Failed to start bitcoind:', error.message);
  });

  const cookiePath = path.join(dataDir, 'regtest', '.cookie');

  try {
    await waitForFile(cookiePath);
    auth = await readCookie(cookiePath);
    await waitForRpc(auth);

    try {
      await rpc(auth, 'createwallet', ['explorer-regtest']);
    } catch (walletError) {
      if (walletError?.code !== -4) {
        throw walletError;
      }
    }

    const miningAddress = await rpc(auth, 'getnewaddress', ['miner']);
    await rpc(auth, 'generatetoaddress', [101, miningAddress]);

    process.env.BITCOIN_RPC_URL = RPC_URL;
    process.env.BITCOIN_RPC_COOKIE = cookiePath;
    process.env.BITCOIN_RPC_TIMEOUT = '5000';
    process.env.BITCOIN_ZMQ_BLOCK = zmqBlock;
    process.env.BITCOIN_ZMQ_TX = zmqTx;
    process.env.FEATURE_MEMPOOL_DASHBOARD = process.env.FEATURE_MEMPOOL_DASHBOARD ?? 'true';
    process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

    const [{ createApp }, { startZmqListener }] = await Promise.all([
      import('../../src/server.js'),
      import('../../src/infra/zmqListener.js')
    ]);

    const app = createApp();
    stopZmq = await startZmqListener({ blockEndpoint: zmqBlock, txEndpoint: zmqTx });
    const agent = request(app);

    const homeResponse = await agent.get('/');
    if (homeResponse.status !== 200) {
      throw new Error(`Unexpected home status: ${homeResponse.status}`);
    }

    const recipient = await rpc(auth, 'getnewaddress', ['recipient']);
    const txid = await rpc(auth, 'sendtoaddress', [recipient, 0.1]);

    await waitFor(async () => {
      const response = await agent.get('/mempool');
      return response.status === 200 && response.text.includes(txid);
    }, { errorMessage: 'Transaction did not appear in mempool dashboard' });

    await rpc(auth, 'generatetoaddress', [1, miningAddress]);

    await waitFor(async () => {
      const response = await agent.get('/mempool');
      return response.status === 200 && !response.text.includes(txid);
    }, { errorMessage: 'Transaction not cleared from mempool after confirmation' });

    console.log('[regtest] Smoke tests passed');

    await stopZmq();
    stopZmq = async () => {};
    await rpc(auth, 'stop');
    rpcStopped = true;
    await once(bitcoind, 'close');
  } finally {
    try {
      await stopZmq();
    } catch {
      // ignore
    }

    if (auth && !rpcStopped) {
      try {
        await rpc(auth, 'stop');
      } catch {
        // ignore
      }
    }

    if (bitcoind.exitCode == null) {
      bitcoind.kill('SIGTERM');
      try {
        await once(bitcoind, 'close');
      } catch {
        // ignore
      }
    }

    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(async (error) => {
  console.error('[regtest] Smoke tests failed:', error);
  process.exitCode = 1;
});
