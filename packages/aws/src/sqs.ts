import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

export function createSqsClient(region?: string): SQSClient {
  return new SQSClient({ region: region || "us-east-1" });
}

export type SqsMessage = {
  messageId: string;
  receiptHandle: string;
  body: string;
};

export type ReceiveMessagesOptions = {
  maxMessages?: number;
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
  abortSignal?: AbortSignal;
};

export async function receiveMessages(
  client: SQSClient,
  queueUrl: string,
  opts: ReceiveMessagesOptions = {},
): Promise<SqsMessage[]> {
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: opts.maxMessages ?? 10,
      WaitTimeSeconds: opts.waitTimeSeconds ?? 20,
      ...(opts.visibilityTimeoutSeconds !== undefined
        ? { VisibilityTimeout: opts.visibilityTimeoutSeconds }
        : {}),
    }),
    { abortSignal: opts.abortSignal },
  );
  return (response.Messages || [])
    .filter((message) => message.MessageId && message.ReceiptHandle && message.Body !== undefined)
    .map((message) => ({
      messageId: message.MessageId as string,
      receiptHandle: message.ReceiptHandle as string,
      body: message.Body as string,
    }));
}

export async function deleteMessage(client: SQSClient, queueUrl: string, receiptHandle: string): Promise<void> {
  await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}
