'use strict';
const state = Object.freeze({ available: false, status: 'unavailable', running: false, evolutionEnabled: false });
const noop = () => undefined;
module.exports = { available: false, startActivityEvolver: noop, checkAndMaybeEvolve: noop, checkGameUpdateEvidence: noop, getEvolveState: () => state };
