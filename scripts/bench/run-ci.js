#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const BITCOIND_PATH = process.env.BITCOIND_PATH || 'bitcoind';
const RPC_PORT = Number(process.env.BENCH_RPC_PORT || 18443);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const SAMPLE_SIZE = Number(process.env.BENCH_SAMPLE_SIZE || 50);
const WARMUPS = Number(process.env.BENCH_WARMUPS || 2);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS || 3);
const OUTPUT_PATH = process.env.BENCH_OUTPUT || 'bench/current-results.json';
const INDEX_PATH = process.env.BENCH_INDEX_PATH || 'bench/ci-index';
const MAX_TX = Number(process.env.BENCH_TX_COUNT || 600);
const SEND_BATCH_CONFIRM_INTERVAL = Number(process.env.BENCH_CONFIRM_EVERY || 20);
const FINAL_CONFIRMATIONS = Number(process.env.BENCH_FINAL_CONFIRMATIONS || 86);

/**
 * @typedef {Error & { code?: number }} RpcError
 */
function log(message, ...rest) {
  console.log(`[bench-ci] ${message}`, ...rest);
}

function waitForFile(filePath, attempts = 50, intervalMs = 200) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    const check = async () => {
      try {
        await readFile(filePath, 'utf8');
        resolve();
      } catch (error) {
        const err = /** @type {NodeJS.ErrnoException | Error} */ (error);
        if (err instanceof Error && 'code' in err && err.code !== 'ENOENT') {
          reject(err);
          return;
        }
        remaining -= 1;
        if (remaining <= 0) {
          reject(new Error(`Timed out waiting for file: ${filePath}`));
          return;
        }
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

async function readCookie(cookiePath) {
  const raw = (await readFile(cookiePath, 'utf8')).trim();
  if (!raw) {
    throw new Error('Bitcoin RPC cookie file is empty');
  }
  if (raw.includes(':')) {
    const [username, password] = raw.split(':', 2);
    return { username, password };
  }
  return { username: '__cookie__', password: raw };
}

async function rpc(auth, method, params = []) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (payload.error) {
    const error = /** @type {RpcError} */ (new Error(payload.error.message || 'RPC error'));
    error.code = typeof payload.error.code === 'number' ? payload.error.code : undefined;
    throw error;
  }
  return payload.result;
}

async function waitForRpc(auth, attempts = 40, intervalMs = 500) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rpc(auth, 'getblockchaininfo');
      return;
    } catch (error) {
      const err = /** @type {Error} */ (error instanceof Error ? error : new Error(String(error)));
      if (i === attempts - 1) {
        throw new Error(`Timed out waiting for bitcoind RPC: ${err.message}`);
      }
      await delay(intervalMs);
    }
  }
}

async function seedChain(auth) {
  log('Creating wallet and funding base chain');
  try {
    await rpc(auth, 'createwallet', ['bench-wallet']);
  } catch (error) {
    const rpcError = /** @type {RpcError} */ (error instanceof Error ? error : new Error(String(error)));
    if (rpcError.code !== -4) {
      throw rpcError;
    }
  }

  const miningAddress = await rpc(auth, 'getnewaddress', ['bench-miner']);
  await rpc(auth, 'generatetoaddress', [110, miningAddress]);

  const recipients = [];
  for (let i = 0; i < SAMPLE_SIZE; i += 1) {
    const address = await rpc(auth, 'getnewaddress', [`bench-address-${i}`]);
    recipients.push(address);
  }

  log(`Broadcasting ${MAX_TX} wallet transactions`);
  for (let i = 0; i < MAX_TX; i += 1) {
    const target = recipients[i % recipients.length];
    const amount = Number((0.05 + (i % 7) * 0.015).toFixed(8));
    await rpc(auth, 'sendtoaddress', [target, amount, '', '', false, false, null, 'unset']);
    if (SEND_BATCH_CONFIRM_INTERVAL > 0 && (i + 1) % SEND_BATCH_CONFIRM_INTERVAL === 0) {
      await rpc(auth, 'generatetoaddress', [1, miningAddress]);
    }
  }

  // Final confirmations to settle transactions.
  await rpc(auth, 'generatetoaddress', [FINAL_CONFIRMATIONS, miningAddress]);
  return recipients;
}

async function runBenchmark(envOverrides = {}, preseededAddresses = []) {
  const args = [
    'scripts/bench/address-indexer-bench.js',
    '--sample', String(SAMPLE_SIZE),
    '--warmups', String(WARMUPS),
    '--iterations', String(ITERATIONS),
    '--output', OUTPUT_PATH
  ];

  const child = spawn('node', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...envOverrides,
      BENCH_PRESEEDED_ADDRESSES: JSON.stringify(preseededAddresses),
      BENCH_BACKEND: envOverrides.BENCH_BACKEND ?? 'leveldb'
    }
  });

  await new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Benchmark exited with status ${code}`));
      } else {
        resolve();
      }
    });
    child.on('error', reject);
  });
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bitcoin-explorer-bench-'));
  log(`Using temporary datadir ${dataDir}`);

  const bitcoind = spawn(BITCOIND_PATH, [
    `-datadir=${dataDir}`,
    '-regtest=1',
    '-server=1',
    '-txindex=1',
    '-listen=0',
    '-dnsseed=0',
    '-discover=0',
    `-rpcbind=127.0.0.1`,
    `-rpcallowip=127.0.0.1`,
    `-rpcport=${RPC_PORT}`,
    '-fallbackfee=0.0001'
  ], {
    stdio: 'ignore'
  });

  bitcoind.on('error', (error) => {
    console.error('[bench-ci] Failed to start bitcoind:', error);
  });

  const cookiePath = path.join(dataDir, 'regtest', '.cookie');
  const bitcoindExit = new Promise((resolve) => {
    bitcoind.on('exit', () => resolve());
  });
  let auth;

  try {
    await waitForFile(cookiePath);
    auth = await readCookie(cookiePath);
    await waitForRpc(auth);
    const recipients = await seedChain(auth);

    const benchmarkEnv = {
      BITCOIN_RPC_URL: RPC_URL,
      BITCOIN_RPC_COOKIE: cookiePath,
      BITCOIN_RPC_TIMEOUT: '5000',
      FEATURE_ADDRESS_EXPLORER: 'true',
      ADDRESS_INDEX_PATH: INDEX_PATH,
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
      BENCH_BACKEND: process.env.BENCH_BACKEND ?? 'leveldb'
    };

    if (existsSync(INDEX_PATH)) {
      await rm(INDEX_PATH, { recursive: true, force: true });
    }

    log('Running benchmark harness');
    await runBenchmark(benchmarkEnv, recipients);

    log('Stopping bitcoind');
    await rpc(auth, 'stop');
    await bitcoindExit;
  } catch (error) {
    console.error('[bench-ci] Benchmark failed:', error);
    if (bitcoind.exitCode === null) {
      bitcoind.kill('SIGTERM');
      await bitcoindExit;
    }
    process.exitCode = 1;
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[bench-ci] Unhandled error:', error);
  process.exitCode = 1;
});
