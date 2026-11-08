import assert from "node:assert/strict";
import { test } from "node:test";
import { failureFromRecord, failureStatus, failureWarning, JEV_PAUSE_MS, nextJevFailure, summarizeJevError } from "../../src/health.ts";

const credits =
	'System One API error (402): {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402,"metadata":{"limit_source":"openrouter_credits"}}}';

test("summarizeJevError: status and the first sentence of the provider message", () => {
	assert.deepEqual(summarizeJevError(credits), { status: 402, short: "402 insufficient credits" });
	assert.deepEqual(summarizeJevError('System One API error (401): {"error":{"message":"No auth credentials found","code":401}}'), { status: 401, short: "401 no auth credentials found" });
	assert.deepEqual(summarizeJevError("fetch failed"), { status: undefined, short: "fetch failed" });
	assert.equal(summarizeJevError(`System One API error (500): ${"x".repeat(200)}`).short.length, 4 + 48);
});

test("nextJevFailure: all failed sets it, a success clears it, timeouts only keep the state", () => {
	const failure = nextJevFailure(undefined, { okRequests: 0, failedRequests: 3, error: credits }, 1_000);
	assert.ok(failure);
	assert.equal(failure.short, "402 insufficient credits");
	assert.equal(failure.failed, 3);
	assert.equal(failure.pausedUntil, 1_000 + JEV_PAUSE_MS);
	assert.equal(failureStatus(failure), "Jev failing: 402 insufficient credits");
	assert.match(failureWarning(failure, 1_000), /every Jev request failed \(3\).*Insufficient credits.*paused for 5 min/);
	assert.equal(nextJevFailure(failure, { okRequests: 0, failedRequests: 0 }, 2_000), failure);
	assert.equal(nextJevFailure(failure, { okRequests: 1, failedRequests: 2, error: credits }, 2_000), undefined);
	// A transient (non-4xx-auth) failure is shown but does not pause requests.
	assert.equal(nextJevFailure(undefined, { okRequests: 0, failedRequests: 1, error: "System One API error (503): upstream" }, 0)?.pausedUntil, 0);
});

test("failureFromRecord: only a record whose every request failed", () => {
	assert.equal(failureFromRecord(undefined), undefined);
	assert.equal(failureFromRecord({ requests: 4, errors: 2, error: credits }), undefined);
	assert.equal(failureFromRecord({ requests: 4 }), undefined);
	const failure = failureFromRecord({ requests: 4, errors: 4, error: credits });
	assert.equal(failure?.short, "402 insufficient credits");
	assert.equal(failure?.pausedUntil, 0);
});
