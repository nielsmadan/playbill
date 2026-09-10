# Experimental report review gate

The coordinator can require an independent signed review before completing its terminal report visit. Enable generated execution history and add an Ed25519 public key to the frozen worker configuration:

```json
{
  "executionHistory": { "reportArtifact": "report.md" },
  "reportReview": {
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
  }
}
```

The controller keeps the private key outside the worker. The worker configuration rejects private PEMs and additional report-review options. The decision limit is fixed at two. Omitting `reportReview` preserves ordinary completion behavior.

`complete VISIT` freezes the exact draft, consumed and produced artifacts, watched source/input/skill hashes, activation, execution facts, original journal events and retained check/artifact snapshots. The request includes the review policy and its exact evidence cutoff. It lives in `.playbill/coordinator/runtime/report-reviews/`; the coordinator pauses before appending generated history or completing the visit.

`review` returns `{ review: { gate, request } }` alongside ordinary state and context. The current request reference and its file SHA-256 are in `state.reportReview.requests.at(-1)`. `status`, `history` and `review` perform no snapshot writes. Pending review permits native Stop to finish; `resume` cannot bypass a pending or exhausted review.

The independent controller reads the frozen bundle, obtains a semantic review outside hooks and state transactions, and writes this envelope:

```json
{
  "decision": {
    "version": 1,
    "requestId": "request UUID",
    "requestHash": "SHA-256 of the complete request file bytes",
    "reportHash": "request.reportHash",
    "evidenceHash": "request.evidenceHash",
    "verdict": "reject",
    "findings": [
      {
        "claim": "Exact offending report claim",
        "evidence": "Specific reference inside the frozen request",
        "reason": "How the evidence contradicts or fails to support the claim"
      }
    ],
    "reviewer": "independent reviewer session identity",
    "reviewedAt": "ISO timestamp"
  },
  "signature": "base64 Ed25519 signature"
}
```

Sign UTF-8 `JSON.stringify(decision)` using Ed25519; `decisionBytes` from `scripts/coordinator/report-review.mjs` exposes those exact bytes. Preserve JSON property order when preparing the envelope. An acceptance uses `"verdict": "accept"`; it may have an empty findings array. Rejection requires at least one finding with a claim, evidence reference and reason. The reviewer identity must differ from the worker session, while the signing key provides decision authenticity.

Submit it externally with `node CLI CONFIG review-decision /absolute/decision.json`. A valid acceptance rechecks all reviewed input hashes and completes in the same state transaction. It then appends generated history and preserves the reviewed narrative separately. The signed controller operation may finish during a worker status-only turn.

A rejection retains its exact envelope and draft, reactivates the same visit and returns feedback for revision. A new `complete` creates a fresh request. A valid signed decision that has become stale is retained and consumes one decision, but never accepts the report. The second rejection or stale decision pauses with an explicit unresolved outcome. Malformed, forged, mismatched and replayed submissions are retained separately and do not consume an authenticated decision.

New native executions after the cutoff invalidate acceptance. Exact coordinator `status`, `history`, `review` and same-visit `complete` shell calls are the bounded exception, including the enclosing completion call's later receipt. Supported spellings use `node` or the current Node executable, absolute or relative CLI/config paths, and unquoted or single-quoted arguments. Shell chaining and substitutions are not exceptions. A pending completion receipt is frozen as pending and cannot establish a successful process outcome; later generated history can include its actual receipt.

This prototype runs with the worker's permissions. The signed gate prevents ordinary CLI self-approval and stale-decision reuse; it does not isolate runtime code, configuration or keys from arbitrary operating-system access. The experiment controller separately audits frozen code/configuration and native inputs. A gate acceptance is a retained review judgment, not proof that the report or repair is correct.

The `review` output includes `latestDecision`, with the signed rejection findings, so a worker revising the current visit can read the actual feedback through the same command. Native Codex transport and the matched experiment are documented in `codex-report-gate.md`.
