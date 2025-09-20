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
const METRICS_PATH_DEFAULT = '/metrics';

function isMetricsEnabled() {
  return process.env.METRICS_ENABLED === 'true';
}

function isAddressCheckEnabled() {
  return process.env.REGTEST_ADDRESS_CHECK === 'true';
}

function extractXpubFromDescriptor(descriptor) {
  if (typeof descriptor !== 'string') {
    throw new Error('Descriptor missing for address');
  }
  const closingBracketIndex = descriptor.indexOf(']');
  if (closingBracketIndex === -1) {
    throw new Error('Descriptor missing xpub metadata');
  }
  const remainder = descriptor.slice(closingBracketIndex + 1);
  const candidate = remainder.split('/')[0];
  if (!candidate) {
    throw new Error('Unable to extract xpub from descriptor');
  }
  return candidate.replace(')', '').replace('#', '');
}

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
  const addressCheckEnabled = isAddressCheckEnabled();

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
    process.env.METRICS_ENABLED = process.env.METRICS_ENABLED ?? (process.env.REGTEST_SCRAPE_METRICS === 'true' ? 'true' : 'false');
    process.env.METRICS_PATH = process.env.METRICS_PATH ?? METRICS_PATH_DEFAULT;
    process.env.METRICS_INCLUDE_DEFAULT = process.env.METRICS_INCLUDE_DEFAULT ?? 'false';
    if (addressCheckEnabled) {
      process.env.FEATURE_ADDRESS_EXPLORER = 'true';
      process.env.ADDRESS_INDEX_PATH = path.join(dataDir, 'address-index');
      process.env.ADDRESS_XPUB_GAP_LIMIT = process.env.ADDRESS_XPUB_GAP_LIMIT ?? '20';
    }

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

    const tipResponse = await agent.get('/api/v1/tip');
    const tipHeight = tipResponse.body?.data?.height;
    const tipHash = tipResponse.body?.data?.bestHash;
    if (tipResponse.status !== 200 || typeof tipHeight !== 'number' || !tipHash) {
      throw new Error('Tip API did not return expected payload');
    }

    const blockResponse = await agent.get(`/api/v1/block/${tipHash}`);
    if (blockResponse.status !== 200 || blockResponse.body?.data?.hash !== tipHash) {
      throw new Error('Block API did not return expected payload');
    }

    let addressIndexerModule = null;
    if (addressCheckEnabled) {
      addressIndexerModule = await import('../../src/infra/addressIndexer.js');
      await waitFor(async () => {
        const indexer = addressIndexerModule.getAddressIndexer();
        if (!indexer) {
          return false;
        }
        const lastProcessed = Number(await indexer.getMetadata('last_processed_height', -1));
        return Number.isFinite(lastProcessed) && lastProcessed >= tipHeight;
      }, { timeoutMs: 120000, errorMessage: 'Address indexer did not catch up to initial tip' });
    }

    const recipient = await rpc(auth, 'getnewaddress', ['recipient']);
    const txid = await rpc(auth, 'sendtoaddress', [recipient, 0.1]);

    await waitFor(async () => {
      const txResponse = await agent.get(`/api/v1/tx/${txid}`);
      return txResponse.status === 200 && txResponse.body?.data?.txid === txid;
    }, { errorMessage: 'Transaction endpoint did not return in time' });

    await waitFor(async () => {
      const response = await agent.get('/mempool');
      return response.status === 200 && response.text.includes(txid);
    }, { errorMessage: 'Transaction did not appear in mempool dashboard' });

    const mempoolApiResponse = await agent.get('/api/v1/mempool');
    const mempoolSnapshotHasTx = mempoolApiResponse.body?.data?.recent?.some((entry) => entry.txid === txid);
    if (mempoolApiResponse.status !== 200 || !mempoolSnapshotHasTx) {
      throw new Error('Transaction missing from mempool API snapshot');
    }

    await rpc(auth, 'generatetoaddress', [1, miningAddress]);

    await waitFor(async () => {
      const response = await agent.get('/mempool');
      return response.status === 200 && !response.text.includes(txid);
    }, { errorMessage: 'Transaction not cleared from mempool after confirmation' });

    await waitFor(async () => {
      const mempoolApiAfter = await agent.get('/api/v1/mempool');
      const stillPresent = mempoolApiAfter.body?.data?.recent?.some((entry) => entry.txid === txid);
      return mempoolApiAfter.status === 200 && !stillPresent;
    }, { errorMessage: 'Transaction still present in mempool API snapshot after confirmation' });

    let tipAfterHeight = tipHeight;
    await waitFor(async () => {
      const tipAfterResponse = await agent.get('/api/v1/tip');
      tipAfterHeight = tipAfterResponse.body?.data?.height;
      return tipAfterResponse.status === 200 && typeof tipAfterHeight === 'number' && tipAfterHeight > tipHeight;
    }, { errorMessage: 'Tip API did not reflect new block height' });

    if (addressCheckEnabled) {
      await waitFor(async () => {
        const indexer = addressIndexerModule.getAddressIndexer();
        if (!indexer) {
          return false;
        }
        try {
          await indexer.processBlockHeight(tipAfterHeight);
          return true;
        } catch (error) {
          if (error && typeof error.message === 'string' && error.message.includes('Block not found')) {
            return false;
          }
          throw error;
        }
      }, { timeoutMs: 120000, errorMessage: 'Address indexer could not process confirmed block height' });

      await waitFor(async () => {
        const indexer = addressIndexerModule.getAddressIndexer();
        if (!indexer) {
          return false;
        }
        const lastProcessed = Number(await indexer.getMetadata('last_processed_height', -1));
        return Number.isFinite(lastProcessed) && lastProcessed >= tipAfterHeight;
      }, { timeoutMs: 120000, errorMessage: 'Address indexer did not catch up to confirmed tip' });

      await waitFor(async () => {
        const addressResponse = await agent.get(`/api/v1/address/${recipient}`);
        const balance = addressResponse.body?.data?.summary?.balanceSat;
        return addressResponse.status === 200 && typeof balance === 'number' && balance > 0;
      }, { timeoutMs: 120000, errorMessage: 'Address API did not confirm funded balance' });

      const addressHtml = await agent.get(`/address/${recipient}`);
      if (addressHtml.status !== 200 || !addressHtml.text.includes(recipient)) {
        throw new Error('Address page did not render expected recipient');
      }

      const addressInfo = await rpc(auth, 'getaddressinfo', [recipient]);
      const descriptor = addressInfo?.desc;
      const xpub = extractXpubFromDescriptor(descriptor);
      const xpubIsExtended = /^[txyql]pub/i.test(xpub);

      if (xpubIsExtended) {
        await waitFor(async () => {
          const response = await agent.get(`/api/v1/xpub/${xpub}`);
          if (response.status !== 200 || !Array.isArray(response.body?.data?.addresses)) {
            return false;
          }
          const fundedEntry = response.body.data.addresses.find((entry) => entry.address === recipient);
          if (!fundedEntry || fundedEntry.balanceSat <= 0) {
            return false;
          }
          return true;
        }, { timeoutMs: 120000, errorMessage: 'Xpub API did not return expected payload' });

        const xpubHtml = await agent.get(`/xpub/${xpub}`);
        if (xpubHtml.status !== 200 || !xpubHtml.text.includes(xpub)) {
          throw new Error('Xpub page did not render expected xpub');
        }
      } else {
        console.warn('[regtest] Skipping xpub checks for non-extended descriptor');
      }
    }

    if (isMetricsEnabled()) {
      const metricsPath = process.env.METRICS_PATH ?? METRICS_PATH_DEFAULT;
      await waitFor(async () => {
        const metricsResponse = await agent.get(metricsPath);
        return metricsResponse.status === 200 && metricsResponse.text.includes('explorer_http_requests_total');
      }, { errorMessage: 'Metrics endpoint did not expose expected counters' });
    }

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
