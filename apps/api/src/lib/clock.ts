/**
 * Minimal wall-clock seam for code that needs injectable time.
 *
 * @param now - Method that returns the current Date.
 * @returns Current time as a Date.
 */
export interface Clock {
	now(): Date;
}

/**
 * Production clock implementation backed by Date.
 *
 * @returns Current system time as a Date.
 */
export class SystemClock implements Clock {
	now(): Date {
		return new Date();
	}
}
