import { parentPort } from 'node:worker_threads';
import { rpcCall } from '../rpc.js';

if (!parentPort) {
  throw new Error('Prevout worker must be run as a worker thread');
}

parentPort.on('message', async ({ id, payload }) => {
  const { txid, vout } = payload ?? {};
  try {
    if (!txid || typeof vout !== 'number') {
      throw new Error('Invalid prevout request');
    }
    const prevTx = await rpcCall('getrawtransaction', [txid, true]);
    const prevout = prevTx?.vout?.find((output) => output.n === vout) || null;
    parentPort.postMessage({ id, success: true, prevout });
  } catch (error) {
    parentPort.postMessage({
      id,
      success: false,
      error: {
        message: error?.message ?? 'Prevout worker error',
        code: error?.code ?? null
      }
    });
  }
});
