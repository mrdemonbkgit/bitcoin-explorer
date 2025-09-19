import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { config } from './config.js';
import { BadRequestError, NotFoundError, ServiceUnavailableError } from './errors.js';
import { getRequestLogger } from './infra/logger.js';

const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 4 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 4 });

let client = await buildClient();

async function buildClient() {
  const auth = await resolveAuth();
  return axios.create({
    baseURL: config.rpc.url,
    timeout: config.rpc.timeout,
    httpAgent,
    httpsAgent,
    auth,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

async function resolveAuth() {
  if (config.rpc.cookiePath) {
    return readCookie(config.rpc.cookiePath);
  }
  if (config.rpc.username && config.rpc.password) {
    return {
      username: config.rpc.username,
      password: config.rpc.password
    };
  }
  throw new ServiceUnavailableError('Bitcoin RPC credentials are not configured');
}

async function readCookie(cookiePath) {
  const raw = (await readFile(cookiePath, 'utf8')).trim();
  if (!raw) {
    throw new ServiceUnavailableError('Bitcoin RPC cookie file is empty');
  }
  if (raw.includes(':')) {
    const [username, password] = raw.split(':', 2);
    return { username, password };
  }
  return { username: '__cookie__', password: raw };
}

async function refreshClient() {
  client = await buildClient();
}

function mapRpcJsonError(error) {
  if (!error || typeof error.code !== 'number') {
    return new ServiceUnavailableError('Unexpected RPC error response');
  }

  switch (error.code) {
    case -5:
      return new NotFoundError(error.message || 'Resource not found');
    case -8:
    case -32602:
      return new BadRequestError(error.message || 'Invalid parameters');
    default:
      return new ServiceUnavailableError(error.message || 'Bitcoin RPC error');
  }
}

function mapAxiosError(error) {
  if (error.response?.status === 401) {
    return new ServiceUnavailableError('Bitcoin RPC authentication failed');
  }
  if (error.code === 'ECONNABORTED' || error.code === 'ECONNREFUSED') {
    return new ServiceUnavailableError('Bitcoin RPC unreachable or timed out');
  }
  return new ServiceUnavailableError('Unexpected error calling Bitcoin RPC');
}

export async function rpcCall(method, params = []) {
  const logger = getRequestLogger();
  const startedAt = process.hrtime.bigint();
  try {
    const { data } = await client.post('/', {
      jsonrpc: '2.0',
      id: method,
      method,
      params
    });

    if (data.error) {
      throw mapRpcJsonError(data.error);
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.debug({
      context: {
        rpc: {
          method,
          durationMs
        }
      }
    }, 'rpc.success');
    return data.result;
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const context = {
      rpc: {
        method,
        durationMs
      }
    };
    const logError = () => {
      logger.error({
        context,
        err: error
      }, 'rpc.failure');
    };
    const logWarn = () => {
      logger.warn({
        context,
        err: error
      }, 'rpc.warning');
    };
    if (error instanceof BadRequestError || error instanceof NotFoundError || error instanceof ServiceUnavailableError) {
      if (error instanceof ServiceUnavailableError) {
        logError();
      } else {
        logWarn();
      }
      throw error;
    }

    if (error.response?.status === 401 && config.rpc.cookiePath) {
      await refreshClient();
      logger.warn({
        context,
        err: error
      }, 'rpc.auth.retry');
      return rpcCall(method, params);
    }
    const mapped = mapAxiosError(error);
    logError();
    throw mapped;
  }
}
