// Supported ordinary levels from the current official Level configuration.
// A new supported type must not expand a saved or default spending policy.
const DEFAULT_FERTILIZER_LAND_TYPES = Object.freeze(['purple', 'gold', 'black', 'red', 'normal']);
const SUPPORTED_FERTILIZER_LAND_TYPES = Object.freeze(['blue', ...DEFAULT_FERTILIZER_LAND_TYPES]);
const LEVEL_TYPES = Object.freeze({ 1: 'normal', 2: 'red', 3: 'black', 4: 'gold', 5: 'purple', 6: 'blue' });

function getLandTypeByLevel(level) {
  const value = Number(level);
  return Number.isInteger(value) ? LEVEL_TYPES[value] || '' : '';
}

module.exports = { DEFAULT_FERTILIZER_LAND_TYPES, SUPPORTED_FERTILIZER_LAND_TYPES, getLandTypeByLevel };
