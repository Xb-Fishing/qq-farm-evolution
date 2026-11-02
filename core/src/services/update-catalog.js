const catalog = require('../gameConfig/UpdateCatalog.json');
// Static configuration only; ownership and activated stars require fresh official state.
function getUpdateCatalog() { return structuredClone(catalog); }
module.exports = { getUpdateCatalog };
