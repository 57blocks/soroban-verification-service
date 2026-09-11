// Jest wants one default export per hook; the reporting itself lives in db-state-report.cjs.
module.exports = require("./db-state-report.cjs").reportStateBeforeRun;
