/** The one definition of "which Postgres the test suites talk to". */
const path = require("node:path");

require("dotenv").config({
  path: path.join(__dirname, "../../../.env"),
  quiet: true,
});

// Matches docker/docker-compose.yml's `postgres:16` service and the root .env.example.
process.env.POSTGRES_HOST ||= "localhost";
process.env.POSTGRES_PORT ||= "5433";
process.env.POSTGRES_DB ||= "scvs";
process.env.POSTGRES_USER ||= "scvs";
process.env.POSTGRES_PASSWORD ||= "scvs_local_dev";
