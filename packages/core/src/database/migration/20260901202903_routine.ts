import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260901202903_routine",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`routine_run\` (
          \`id\` text PRIMARY KEY,
          \`routine_id\` text NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`started_at\` integer NOT NULL,
          \`finished_at\` integer,
          \`error\` text,
          CONSTRAINT \`fk_routine_run_routine_id_routine_id_fk\` FOREIGN KEY (\`routine_id\`) REFERENCES \`routine\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`routine\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`name\` text NOT NULL,
          \`schedule\` text NOT NULL,
          \`timezone\` text NOT NULL,
          \`prompt\` text,
          \`command_id\` text,
          \`model\` text,
          \`enabled\` integer NOT NULL,
          \`last_run_at\` integer,
          \`next_run_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`routine_run_routine_idx\` ON \`routine_run\` (\`routine_id\`,\`started_at\`);`)
      yield* tx.run(`CREATE INDEX \`routine_run_session_idx\` ON \`routine_run\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`routine_directory_idx\` ON \`routine\` (\`directory\`);`)
      yield* tx.run(`CREATE INDEX \`routine_due_idx\` ON \`routine\` (\`enabled\`,\`next_run_at\`);`)
    })
  },
}

export default migration
