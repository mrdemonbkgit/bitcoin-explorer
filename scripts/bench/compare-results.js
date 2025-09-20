#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const options = {
    current: null,
    baseline: null,
    maxIngestDelta: Number(process.env.BENCH_MAX_INGEST_DELTA ?? '0.60'),
    maxSummaryDelta: Number(process.env.BENCH_MAX_SUMMARY_DELTA ?? '0.80'),
    maxTxDelta: Number(process.env.BENCH_MAX_TX_DELTA ?? '0.60'),
    maxUtxoDelta: Number(process.env.BENCH_MAX_UTXO_DELTA ?? '0.95')
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--current':
        options.current = argv[++i];
        break;
      case '--baseline':
        options.baseline = argv[++i];
        break;
      case '--max-ingest-delta':
        options.maxIngestDelta = Number(argv[++i]);
        break;
      case '--max-summary-delta':
        options.maxSummaryDelta = Number(argv[++i]);
        break;
      case '--max-tx-delta':
        options.maxTxDelta = Number(argv[++i]);
        break;
      case '--max-utxo-delta':
        options.maxUtxoDelta = Number(argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.current || !options.baseline) {
    throw new Error('Usage: node scripts/bench/compare-results.js --current <path> --baseline <path> [--max-ingest-delta <float>] [--max-read-delta <float>]');
  }

  return options;
}

function loadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${filePath}: ${error.message}`);
  }
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function compareMetric(name, current, baseline, maxDelta) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) {
    console.log(`[bench-compare] Skipping ${name} (baseline=${baseline}, current=${current})`);
    return { passed: true, delta: 0 };
  }
  const ratio = current / baseline - 1;
  const passed = ratio <= maxDelta;
  console.log(`[bench-compare] ${name}: current=${current.toFixed(6)} baseline=${baseline.toFixed(6)} delta=${formatPercent(ratio)}`);
  if (!passed) {
    console.error(`[bench-compare] ${name} exceeded allowed delta of ${formatPercent(maxDelta)}`);
  }
  return { passed, delta: ratio };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error('[bench-compare] Argument error:', error.message);
    process.exitCode = 1;
    return;
  }
  const current = loadJson(options.current);
  const baseline = loadJson(options.baseline);

  const checks = [
    compareMetric('ingestSeconds', current.ingestSeconds, baseline.ingestSeconds, options.maxIngestDelta),
    compareMetric('summaryAvgMs', current.reads.summaryAvgMs, baseline.reads.summaryAvgMs, options.maxSummaryDelta),
    compareMetric('transactionsAvgMs', current.reads.transactionsAvgMs, baseline.reads.transactionsAvgMs, options.maxTxDelta),
    compareMetric('utxosAvgMs', current.reads.utxosAvgMs, baseline.reads.utxosAvgMs, options.maxUtxoDelta)
  ];

  const failed = checks.some((check) => !check.passed);
  if (failed) {
    process.exitCode = 1;
  }
}

main();
