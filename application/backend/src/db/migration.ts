import migrate from "node-pg-migrate";
import { MigrationDirection } from "node-pg-migrate/dist/types";
import { resolve } from "path";
import { client, clientConfig } from "./config";
import { Pool } from "pg";

async function setupDb() {
  console.log("Running DB migrations", client, JSON.stringify(clientConfig));
  await migrate({
    dbClient: new Pool(clientConfig) as any,
    count: Infinity,
    createMigrationsSchema: true,
    createSchema: true,
    dir: resolve(__dirname, "../../migrations"),
    direction: "up" as MigrationDirection,
    ignorePattern: ".*.ts",
    logger: console,
    migrationsTable: "migrations",
    verbose: true,
  });
  console.log("Done running migrations");
}

export const dbMigrationDone = setupDb();
