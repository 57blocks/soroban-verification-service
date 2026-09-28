import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type PresignPutOptions = {
  expiresInSeconds?: number;
  contentType?: string;
};

export type PresignGetOptions = {
  expiresInSeconds?: number;
};

const DEFAULT_EXPIRES_IN_SECONDS = 15 * 60;

export async function presignPutUrl(
  client: S3Client,
  bucket: string,
  key: string,
  opts: PresignPutOptions = {}
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(opts.contentType ? { ContentType: opts.contentType } : {}),
  });
  return getSignedUrl(client, command, {
    expiresIn: opts.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS,
  });
}

export async function presignGetUrl(
  client: S3Client,
  bucket: string,
  key: string,
  opts: PresignGetOptions = {}
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, {
    expiresIn: opts.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS,
  });
}
