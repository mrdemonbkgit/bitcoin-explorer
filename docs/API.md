# JSON API Reference — Slim Bitcoin Explorer

All endpoints are available under the `/api/v1` prefix. Responses use JSON envelopes of the form:

```
{
  "data": { ...resource payload... },
  "meta": { ...optional metadata... }
}
```

Errors are returned with HTTP status codes and the payload:
```
{
  "error": {
    "code": <status>,
    "type": <error name>,
    "message": <human-readable message>
  },
  "meta": {}
}
```

## Authentication
No authentication is required for LAN deployments (matches current HTML routes). If you introduce access control in the future, document headers/tokens here.

## Endpoints

### GET `/api/v1/tip`
Returns current chain tip information plus mempool summary and fee estimates.

**Sample request:**
```bash
curl http://localhost:28765/api/v1/tip
```

**Response:**
```json
{
  "data": {
    "chain": "main",
    "height": 810123,
    "bestHash": "0000000000...",
    "mempool": {
      "txCount": 5234,
      "bytes": 8456123
    },
    "feeEstimates": {
      "1": 32.5,
      "3": 18.2,
      "6": 12.1
    }
  },
  "meta": {
    "generatedAt": "2025-09-20T00:00:00.000Z"
  }
}
```

### GET `/api/v1/block/:id`
Fetch block metadata by height or hash. Supports pagination of transaction IDs via the `page` query parameter (default `1`).

**Sample request:**
```bash
curl "http://localhost:28765/api/v1/block/800000?page=2"
```

**Response (truncated):**
```json
{
  "data": {
    "hash": "00000000000...",
    "height": 800000,
    "timestamp": 1700000000,
    "size": 1254789,
    "weight": 3999000,
    "version": 0x20000000,
    "bits": "170c1be7",
    "difficulty": 4321764714867.91,
    "previousBlockHash": "0000000000...",
    "nextBlockHash": "0000000000...",
    "txCount": 2154,
    "txids": ["..."],
    "pagination": {
      "page": 2,
      "totalPages": 87,
      "pageSize": 25
    }
  },
  "meta": {}
}
```

### GET `/api/v1/tx/:txid`
Returns full transaction details including resolved input/output addresses, aggregated value totals, and the RBF hint.

**Sample request:**
```bash
curl http://localhost:28765/api/v1/tx/aef1...c0
```

**Response (truncated):**
```json
{
  "data": {
    "txid": "aef1...c0",
    "hash": "aef1...c0",
    "size": 210,
    "weight": 840,
    "locktime": 0,
    "vin": [
      {
        "txid": "9f7c...cd",
        "vout": 0,
        "sequence": 4294967293,
        "addresses": ["bc1qexampleinput"],
        "prevout": {
          "value": 1.20000000,
          "scriptPubKey": {
            "type": "witness_v0_keyhash"
          }
        }
      }
    ],
    "vout": [
      {
        "n": 0,
        "value": 0.80000000,
        "addresses": ["bc1qexampleoutput"],
        "scriptPubKey": {
          "type": "witness_v0_keyhash"
        }
      },
      {
        "n": 1,
        "value": 0.39990000,
        "addresses": [],
        "scriptPubKey": {
          "type": "nulldata"
        }
      }
    ],
    "inputValue": 1.5000,
    "outputValue": 1.4990,
    "fee": 0.0010,
    "isRbf": false
  },
  "meta": {}
}
```

### GET `/api/v1/mempool`
Provides a snapshot of the mempool (summary + histogram + recent transactions). Supports `page` query for pagination of recent transactions (matches HTML dashboard).

**Sample request:**
```bash
curl "http://localhost:28765/api/v1/mempool?page=1"
```

**Response (truncated):**
```json
{
  "data": {
    "updatedAt": "2025-09-20T01:10:00.123Z",
    "txCount": 12234,
    "virtualSize": 8456123,
    "medianFee": 25.4,
    "histogram": [
      { "range": "0-1", "count": 123, "vsize": 5000 },
      { "range": "1-5", "count": 421, "vsize": 14500 }
    ],
    "recent": [
      {
        "txid": "...",
        "feerate": 18.2,
        "vsize": 220,
        "ageSeconds": 42,
        "isRbf": false
      }
    ]
  },
  "meta": {
    "pagination": {
      "page": 1,
      "pageSize": 25,
      "totalPages": 490
    }
  }
}
```

## Content Negotiation
- API responses always return JSON; requests without an `Accept` header default to JSON.
- HTML routes remain unchanged; visit `/`, `/block/:id`, etc. for server-rendered views.

## Error Codes
- `400` — invalid parameters (e.g., bad hash format, invalid page number)
- `404` — resource not found (unknown block/tx)
- `503` — upstream Bitcoin Core unavailable or timed out

## Testing
- Automated coverage lives in `test/integration/api.test.js` and `test/integration/parity.test.js`.
- Manual verification commands are listed in `docs/TESTING.md`.
