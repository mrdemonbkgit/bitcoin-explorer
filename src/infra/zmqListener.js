import { createHash } from 'node:crypto';
import { Subscriber } from 'zeromq';
import { CacheEvents, emit } from './cacheEvents.js';
import { getLogger } from './logger.js';

const DOUBLE_SHA256 = (buffer) => createHash('sha256').update(createHash('sha256').update(buffer).digest()).digest();

function bufferToHexLE(buffer) {
  return Buffer.from(buffer).reverse().toString('hex');
}

function decodeBlockHash(raw) {
  const header = raw.subarray(0, 80);
  const hash = DOUBLE_SHA256(header);
  return bufferToHexLE(hash);
}

function decodeTxId(raw) {
  const hash = DOUBLE_SHA256(raw);
  return bufferToHexLE(hash);
}

export async function startZmqListener({ blockEndpoint = null, txEndpoint = null }) {
  if (!blockEndpoint && !txEndpoint) {
    return async () => {};
  }

  const logger = getLogger().child({ module: 'zmq' });
  const sockets = [];
  let lastBlockHash = null;
  let lastBlockTimestamp = 0;
  let closed = false;

  async function bindSocket(topic, endpoint, handler) {
    const subscriber = new Subscriber();
    subscriber.connect(endpoint);
    subscriber.subscribe(topic);
    logger.info({
      context: {
        zmq: {
          topic,
          endpoint,
          event: 'subscribe'
        }
      }
    }, 'zmq.subscribe');

    const reader = (async () => {
      try {
        for await (const [receivedTopic, payload] of subscriber) {
          if (closed) {
            break;
          }
          const topicName = receivedTopic.toString();
          try {
            handler(payload);
            logger.debug({
              context: {
                zmq: {
                  topic: topicName,
                  bytes: payload?.length ?? 0,
                  event: 'message'
                }
              }
            }, 'zmq.message');
          } catch (error) {
            logger.error({
              context: {
                zmq: {
                  topic: topicName,
                  event: 'handler.error'
                }
              },
              err: error
            }, 'zmq.handler.error');
          }
        }
      } catch (error) {
        if (!closed) {
          logger.error({
            context: {
              zmq: {
                topic,
                endpoint,
                event: 'stream.error'
              }
            },
            err: error
          }, 'zmq.stream.error');
        }
      }
    })();

    sockets.push({ subscriber, reader, topic, endpoint });
  }

  if (blockEndpoint) {
    await bindSocket('rawblock', blockEndpoint, (payload) => {
      const hash = decodeBlockHash(payload);
      const now = Date.now();
      if (lastBlockHash === hash && now - lastBlockTimestamp < 100) {
        return;
      }
      lastBlockHash = hash;
      lastBlockTimestamp = now;
      emit(CacheEvents.BLOCK_NEW, { hash, raw: payload });
    });
  }

  if (txEndpoint) {
    await bindSocket('rawtx', txEndpoint, (payload) => {
      const txid = decodeTxId(payload);
      emit(CacheEvents.TX_NEW, { txid, raw: payload });
    });
  }

  return async () => {
    closed = true;
    await Promise.all(sockets.map(async ({ subscriber }) => {
      try {
        subscriber.close();
      } catch (error) {
        logger.warn({
          context: {
            zmq: {
              event: 'close.error'
            }
          },
          err: error
        }, 'zmq.close.error');
      }
    }));
  };
}

export const __testUtils = {
  decodeBlockHash,
  decodeTxId
};
