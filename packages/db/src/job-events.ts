import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Client as PgClient } from "pg";
import { DB_CONNECTION_STRING } from "./db.tokens.js";

const CHANNEL = "scvs_job_updates";

export type JobUpdateListener = (jobId: string) => void;

/** LISTEN side of the `pg_notify` that `JobsRepository` issues after every write. */
@Injectable()
export class JobEventsService implements OnModuleDestroy {
  private listenClient: PgClient | undefined;
  private connecting: Promise<PgClient> | undefined;
  private readonly listeners = new Set<JobUpdateListener>();

  constructor(
    @Inject(DB_CONNECTION_STRING) private readonly connectionString: string,
  ) {}

  /** Callers must call the returned unsubscribe when done, or the listener leaks. */
  async subscribeToJobUpdates(listener: JobUpdateListener): Promise<() => void> {
    await this.ensureListening();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.listeners.clear();
    const client = this.listenClient;
    this.listenClient = undefined;
    this.connecting = undefined;
    if (client) {
      await client.end().catch((error) => {
        console.error("[db] job-events failed to close its LISTEN connection", error);
      });
    }
  }

  private async ensureListening(): Promise<PgClient> {
    if (this.listenClient) return this.listenClient;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new PgClient({ connectionString: this.connectionString });
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);

      client.on("notification", (message) => {
        if (message.channel !== CHANNEL || !message.payload) return;
        for (const listener of this.listeners) {
          try {
            listener(message.payload);
          } catch (error) {
            console.error("[db] job-events listener threw", error);
          }
        }
      });

      client.on("error", (error) => {
        console.error(
          "[db] job-events LISTEN connection error, will reconnect on next subscribe",
          error,
        );
        this.listenClient = undefined;
        this.connecting = undefined;
      });

      this.listenClient = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
}
