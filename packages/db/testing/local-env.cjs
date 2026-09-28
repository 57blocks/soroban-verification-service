const path = require("node:path");

require("dotenv").config({
  path: path.join(__dirname, "../../../.env"),
  quiet: true,
});

process.env.POSTGRES_HOST ||= "localhost";
process.env.POSTGRES_PORT ||= "5433";
process.env.POSTGRES_DB ||= "scvs";
process.env.POSTGRES_USER ||= "scvs";
process.env.POSTGRES_PASSWORD ||= "scvs_local_dev";
