import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createSqsClient, deleteMessage, receiveMessages } from "@scvs/aws";
import { ScvsLogger } from "@scvs/core";
import { BatchEventHandlerService } from "./batch-event-handler.service.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class BatchEventConsumerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new ScvsLogger("batch-event-consumer");
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private readonly abortController = new AbortController();

  // Explicit @Inject(): tsx/esbuild emits no decorator metadata for Nest to infer parameter types from.
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(BatchEventHandlerService)
    private readonly handler: BatchEventHandlerService
  ) {}

  onModuleInit(): void {
    const queueUrl = this.configService.get("jobStateChangeQueueUrl", {
      infer: true,
    });
    if (!queueUrl) {
      throw new Error(
        "SCVS_JOB_STATE_CHANGE_QUEUE_URL is required — orchestrator-svc always dispatches builds via AWS Batch."
      );
    }
    this.loopPromise = this.consume(queueUrl);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.abortController.abort();
    await this.loopPromise;
  }

  private async consume(queueUrl: string): Promise<void> {
    const sqs = createSqsClient(
      this.configService.get("awsRegion", { infer: true })
    );
    this.logger.log("listening on the Batch job-state-change queue", { queue_url: queueUrl });
    while (!this.stopped) {
      try {
        const messages = await receiveMessages(sqs, queueUrl, {
          abortSignal: this.abortController.signal,
        });
        if (messages.length > 0) {
          this.logger.log("received Batch job-state-change messages", {
            count: messages.length,
          });
        }
        for (const message of messages) {
          try {
            await this.handler.onBatchJobStateChangeEvent(
              JSON.parse(message.body)
            );

            // Never log the body: the Batch event it carries holds a presigned S3 PUT URL.
            this.logger.log("processed a Batch job-state-change message", {
              receipt_handle_prefix: message.receiptHandle.slice(0, 16),
            });
          } catch (error) {
            // Not deleted: SQS redelivers it after the visibility timeout.
            this.logger.error("failed to process a Batch job-state-change message", {
              error: error instanceof Error ? error : String(error),
            });
            continue;
          }
          await deleteMessage(sqs, queueUrl, message.receiptHandle);
        }
      } catch (error) {
        if (!this.stopped) {
          this.logger.error("Batch job-state-change queue poll failed", {
            error: error instanceof Error ? error : String(error),
          });
        }
      }
    }
  }
}
