import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { getLogger } from './logger.js';
import { rpcCall } from '../rpc.js';
import { CacheEvents, subscribe } from './cacheEvents.js';

const SATOSHIS_PER_BTC = 100_000_000;
let singletonIndexer = null;

function sats(value) {
  if (typeof value !== 'number') {
    return 0;
  }
  return Math.round(value * SATOSHIS_PER_BTC);
}

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
}

export class AddressIndexer {
  constructor(options = {}) {
    const { dbPath, gapLimit, logger } = options;
    this.dbPath = dbPath ?? path.resolve('./data/address-index.db');
    this.gapLimit = gapLimit ?? 20;
    this.logger = logger ?? getLogger().child({ module: 'address-indexer' });
    this.db = null;
    this.statements = {};
    this.subscriptions = [];
    this.prevoutCache = new Map();
  }

  open() {
    ensureDirectory(this.dbPath);
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.setupSchema();
    this.prepareStatements();
  }

  setupSchema() {
    const schema = `
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS addresses (
        address TEXT PRIMARY KEY,
        first_seen_height INTEGER,
        last_seen_height INTEGER,
        total_received_sat INTEGER NOT NULL DEFAULT 0,
        total_sent_sat INTEGER NOT NULL DEFAULT 0,
        balance_sat INTEGER NOT NULL DEFAULT 0,
        tx_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS address_utxos (
        address TEXT NOT NULL,
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        value_sat INTEGER NOT NULL,
        height INTEGER,
        PRIMARY KEY (address, txid, vout),
        FOREIGN KEY (address) REFERENCES addresses(address) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS address_txs (
        address TEXT NOT NULL,
        txid TEXT NOT NULL,
        height INTEGER,
        direction TEXT NOT NULL,
        value_sat INTEGER NOT NULL,
        io_index INTEGER NOT NULL,
        timestamp INTEGER,
        PRIMARY KEY (address, txid, direction, io_index),
        FOREIGN KEY (address) REFERENCES addresses(address) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS xpubs (
        xpub TEXT PRIMARY KEY,
        label TEXT,
        last_scanned_external INTEGER NOT NULL DEFAULT -1,
        last_scanned_internal INTEGER NOT NULL DEFAULT -1,
        gap_limit INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS xpub_addresses (
        xpub TEXT NOT NULL,
        branch INTEGER NOT NULL,
        derivation_index INTEGER NOT NULL,
        address TEXT NOT NULL,
        PRIMARY KEY (xpub, branch, derivation_index),
        FOREIGN KEY (xpub) REFERENCES xpubs(xpub) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_address_txs_height ON address_txs(address, height DESC);
      CREATE INDEX IF NOT EXISTS idx_address_utxos_value ON address_utxos(address, value_sat DESC);
    `;

    this.db.exec(schema);
  }

  prepareStatements() {
    const insertMetadata = this.db.prepare(`REPLACE INTO metadata (key, value) VALUES (?, ?)`);
    const selectMetadata = this.db.prepare(`SELECT value FROM metadata WHERE key = ?`);
    const upsertAddress = this.db.prepare(`
      INSERT INTO addresses (address, first_seen_height, last_seen_height)
      VALUES (@address, @height, @height)
      ON CONFLICT(address) DO UPDATE SET last_seen_height = MAX(addresses.last_seen_height, excluded.last_seen_height)
    `);
    const addInbound = this.db.prepare(`
      UPDATE addresses
      SET total_received_sat = total_received_sat + @value,
          balance_sat = balance_sat + @value,
          tx_count = tx_count + CASE WHEN @incrementTx = 1 THEN 1 ELSE 0 END
      WHERE address = @address
    `);
    const addOutbound = this.db.prepare(`
      UPDATE addresses
      SET total_sent_sat = total_sent_sat + @value,
          balance_sat = balance_sat - @value,
          tx_count = tx_count + CASE WHEN @incrementTx = 1 THEN 1 ELSE 0 END,
          last_seen_height = MAX(last_seen_height, @height)
      WHERE address = @address
    `);
    const insertUtxo = this.db.prepare(`
      INSERT OR REPLACE INTO address_utxos (address, txid, vout, value_sat, height)
      VALUES (@address, @txid, @vout, @value, @height)
    `);
    const deleteUtxo = this.db.prepare(`DELETE FROM address_utxos WHERE address = ? AND txid = ? AND vout = ?`);
    const insertTx = this.db.prepare(`
      INSERT OR IGNORE INTO address_txs (address, txid, height, direction, value_sat, io_index, timestamp)
      VALUES (@address, @txid, @height, @direction, @value, @ioIndex, @timestamp)
    `);

    this.statements = {
      insertMetadata,
      selectMetadata,
      upsertAddress,
      addInbound,
      addOutbound,
      insertUtxo,
      deleteUtxo,
      insertTx
    };
  }

  getMetadata(key, fallback = null) {
    const row = this.statements.selectMetadata.get(key);
    if (!row) {
      return fallback;
    }
    return row.value;
  }

  setMetadata(key, value) {
    this.statements.insertMetadata.run(key, String(value));
  }

  async start() {
    if (this.db) {
      return;
    }
    this.open();
    await this.initialSync();
    this.watchZmq();
  }

  async initialSync() {
    const bestHeight = await rpcCall('getblockcount');
    const lastProcessed = Number(this.getMetadata('last_processed_height', -1));
    let nextHeight = lastProcessed + 1;

    while (nextHeight <= bestHeight) {
      await this.processBlockHeight(nextHeight);
      this.setMetadata('last_processed_height', nextHeight);
      nextHeight += 1;
    }

    this.logger.info({
      context: {
        event: 'addressIndexer.sync.complete',
        height: bestHeight
      }
    }, 'Address index initial sync complete');
  }

  async processBlockHeight(height) {
    const hash = await rpcCall('getblockhash', [height]);
    await this.processBlockHash(hash, height);
  }

  async processBlockHash(hash, expectedHeight = null) {
    const block = await rpcCall('getblock', [hash, 2]);
    const height = expectedHeight ?? block.height;
    const timestamp = block.time ?? null;

    const transactionsWithPrevouts = [];
    for (const transaction of block.tx || []) {
      // Preload prevouts before entering SQLite transaction
      const prevouts = await this.fetchPrevouts(transaction);
      transactionsWithPrevouts.push({ transaction, prevouts });
    }

    const tx = this.db.transaction((entries) => {
      for (const entry of entries) {
        this.processTransaction(entry.transaction, entry.prevouts, height, timestamp);
      }
    });

    tx(transactionsWithPrevouts);
    this.setMetadata('last_processed_hash', hash);
    this.setMetadata('last_processed_height', height);
  }

  processTransaction(transaction, prevouts, height, timestamp) {
    const addressesSeen = new Set();

    // Outputs
    for (const output of transaction.vout || []) {
      if (!output.scriptPubKey) {
        continue;
      }
      const addresses = output.scriptPubKey.addresses || (output.scriptPubKey.address ? [output.scriptPubKey.address] : []);
      if (!Array.isArray(addresses) || addresses.length === 0) {
        continue;
      }
      const value = sats(output.value ?? 0);
      for (const address of addresses) {
        addressesSeen.add(address);
        this.recordInbound(address, transaction.txid, output.n ?? 0, value, height, timestamp);
      }
    }

    // Inputs
    (transaction.vin || []).forEach((input, index) => {
      if (input.coinbase) {
        return;
      }
      const prevout = prevouts[index];
      if (!prevout) {
        return;
      }
      const value = sats(prevout.value ?? 0);
      const addresses = prevout.scriptPubKey?.addresses || (prevout.scriptPubKey?.address ? [prevout.scriptPubKey.address] : []);
      for (const address of addresses) {
        this.recordOutbound(address, input.txid, input.vout ?? 0, transaction.txid, value, height, timestamp, !addressesSeen.has(address));
      }
    });
  }

  recordInbound(address, txid, vout, value, height, timestamp) {
    this.statements.upsertAddress.run({ address, height });
    this.statements.addInbound.run({ address, value, incrementTx: 1 });
    this.statements.insertUtxo.run({ address, txid, vout, value, height });
    this.statements.insertTx.run({
      address,
      txid,
      height,
      direction: 'in',
      value,
      ioIndex: vout,
      timestamp
    });
  }

  recordOutbound(address, prevTxid, prevVout, currentTxid, value, height, timestamp, incrementTx) {
    this.statements.upsertAddress.run({ address, height });
    this.statements.addOutbound.run({ address, value, height, incrementTx: incrementTx ? 1 : 0 });
    this.statements.deleteUtxo.run(address, prevTxid, prevVout);
    this.statements.insertTx.run({
      address,
      txid: currentTxid,
      height,
      direction: 'out',
      value,
      ioIndex: prevVout,
      timestamp
    });
  }

  async fetchPrevouts(transaction) {
    const results = [];
    for (const input of transaction.vin || []) {
      if (input.coinbase) {
        results.push(null);
        continue;
      }
      const key = `${input.txid}:${input.vout}`;
      if (this.prevoutCache.has(key)) {
        results.push(this.prevoutCache.get(key));
        continue;
      }
      try {
        this.logger.debug({ context: { event: 'addressIndexer.prevout.fetch', txid: input.txid } }, 'Fetching prevout via RPC');
        const prevTx = await rpcCall('getrawtransaction', [input.txid, true]);
        const prevout = prevTx?.vout?.find((output) => output.n === input.vout) || null;
        if (prevout) {
          this.prevoutCache.set(key, prevout);
        }
        results.push(prevout);
      } catch (error) {
        this.logger.warn({ context: { event: 'addressIndexer.prevout.error', txid: input.txid }, err: error }, 'Failed to fetch prevout');
        results.push(null);
      }
    }
    return results;
  }

  async watchZmq() {
    const unsubscribeBlock = subscribe(CacheEvents.BLOCK_NEW, async ({ hash }) => {
      try {
        await this.processBlockHash(hash);
      } catch (error) {
        this.logger.error({ context: { event: 'addressIndexer.block.error', hash }, err: error }, 'Failed to process new block');
      }
    });

    this.subscriptions.push(unsubscribeBlock);
  }

  close() {
    for (const unsubscribe of this.subscriptions) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
    this.subscriptions = [];
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Query helpers
  getAddressSummary(address) {
    const row = this.db.prepare(`SELECT * FROM addresses WHERE address = ?`).get(address);
    if (!row) {
      return null;
    }
    const utxoStats = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(value_sat), 0) AS total FROM address_utxos WHERE address = ?`).get(address);
    return {
      address,
      firstSeenHeight: row.first_seen_height,
      lastSeenHeight: row.last_seen_height,
      totalReceivedSat: row.total_received_sat,
      totalSentSat: row.total_sent_sat,
      balanceSat: row.balance_sat,
      txCount: row.tx_count,
      utxoCount: utxoStats?.count ?? 0,
      utxoValueSat: utxoStats?.total ?? 0
    };
  }

  getAddressTransactions(address, { page = 1, pageSize = 25 }) {
    const offset = (page - 1) * pageSize;
    const rows = this.db
      .prepare(`
        SELECT txid, height, direction, value_sat, io_index, timestamp
        FROM address_txs
        WHERE address = ?
        ORDER BY COALESCE(height, 1 << 30) DESC, txid
        LIMIT ? OFFSET ?
      `)
      .all(address, pageSize, offset);

    const totalRows = this.db
      .prepare(`SELECT COUNT(*) AS count FROM address_txs WHERE address = ?`)
      .get(address)?.count || 0;

    return {
      rows,
      pagination: {
        page,
        pageSize,
        totalRows
      }
    };
  }

  getAddressUtxos(address) {
    return this.db
      .prepare(`SELECT txid, vout, value_sat, height FROM address_utxos WHERE address = ? ORDER BY value_sat DESC`)
      .all(address);
  }
}

export async function startAddressIndexer() {
  if (!config.address.enabled) {
    return null;
  }
  if (!singletonIndexer) {
    singletonIndexer = new AddressIndexer({
      dbPath: path.resolve(config.address.indexPath),
      gapLimit: config.address.xpubGapLimit,
      logger: getLogger().child({ module: 'address-indexer' })
    });
    await singletonIndexer.start();
  }
  return singletonIndexer;
}

export function getAddressIndexer() {
  return singletonIndexer;
}

export function stopAddressIndexer() {
  if (singletonIndexer) {
    singletonIndexer.close();
    singletonIndexer = null;
  }
}
