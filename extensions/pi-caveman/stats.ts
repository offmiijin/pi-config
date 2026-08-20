import type { CavemanStatsSnapshot, CompressionOutcome } from "./types.ts";

export class StatsTracker {
	private values: CavemanStatsSnapshot = {
		seen: 0,
		compressed: 0,
		skipped: 0,
		originalBytes: 0,
		outputBytes: 0,
		recovered: 0,
		failures: 0,
	};

	record(outcome: CompressionOutcome): void {
		this.values.seen += 1;
		if (outcome.changed) {
			this.values.compressed += 1;
			this.values.originalBytes += outcome.originalBytes;
			this.values.outputBytes += outcome.outputBytes;
		} else {
			this.values.skipped += 1;
		}
	}

	recordRecovery(): void {
		this.values.recovered += 1;
	}

	recordFailure(): void {
		this.values.failures += 1;
	}

	snapshot(): CavemanStatsSnapshot {
		return { ...this.values };
	}

	reset(): void {
		this.values = {
			seen: 0,
			compressed: 0,
			skipped: 0,
			originalBytes: 0,
			outputBytes: 0,
			recovered: 0,
			failures: 0,
		};
	}
}
