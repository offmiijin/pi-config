/**
 * pi-memory — Testes: shim mínimo de `expect` sobre node:assert/strict.
 *
 * Substitui o matcher do bun:test quando a suíte roda sob Node (node --test).
 * Cobre apenas os matchers usados nos testes da extensão — nada além disso.
 */

import assert from "node:assert/strict";

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function expect(actual: unknown) {
	const contains = (sub: unknown, negate = false): void => {
		const found = Array.isArray(actual)
			? (actual as unknown[]).includes(sub)
			: String(actual).includes(String(sub));
		if (negate) {
			assert.ok(!found, `expected ${stringify(actual)} NOT to contain ${stringify(sub)}`);
		} else {
			assert.ok(found, `expected ${stringify(actual)} to contain ${stringify(sub)}`);
		}
	};

	return {
		toBe: (expected: unknown) => assert.strictEqual(actual, expected),
		toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
		toContain: (sub: unknown) => contains(sub),
		toMatch: (re: RegExp) => assert.match(String(actual), re),
		toBeTrue: () => assert.strictEqual(actual, true),
		toBeFalse: () => assert.strictEqual(actual, false),
		toBeUndefined: () => assert.strictEqual(actual, undefined),
		toBeDefined: () => assert.notStrictEqual(actual, undefined),
		toBeNull: () => assert.strictEqual(actual, null),
		toBeCloseTo: (expected: number, precision = 2) =>
			assert.ok(
				Math.abs((actual as number) - expected) < Math.pow(10, -precision),
				`expected ${String(actual)} to be close to ${expected}`,
			),
		toHaveLength: (n: number) =>
			assert.strictEqual((actual as { length: number }).length, n),
		toBeGreaterThan: (n: number) => assert.ok((actual as number) > n),
		toBeGreaterThanOrEqual: (n: number) => assert.ok((actual as number) >= n),
		toBeLessThan: (n: number) => assert.ok((actual as number) < n),
		toBeLessThanOrEqual: (n: number) => assert.ok((actual as number) <= n),
		toThrow: (re?: RegExp | string) => {
			const fn = actual as () => unknown;
			if (re === undefined) assert.throws(fn);
			else if (re instanceof RegExp) assert.throws(fn, re);
			else assert.throws(fn, new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		},
		not: {
			toBe: (expected: unknown) => assert.notStrictEqual(actual, expected),
			toContain: (sub: unknown) => contains(sub, true),
			toMatch: (re: RegExp) => assert.doesNotMatch(String(actual), re),
			toThrow: () => assert.doesNotThrow(actual as () => unknown),
		},
	};
}
