'use strict';
if (!require('../runtime/optional-module-provider').attach(module)) {
  module.exports = { available: false, recordRuntimeIssue: () => false };
}
