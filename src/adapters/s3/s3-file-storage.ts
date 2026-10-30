import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { FileStorage } from '../../domain';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  /** e.g. http://minio:9000 locally; undefined for real AWS. */
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/** Works against AWS S3 and any S3-compatible store such as MinIO. */
export class S3FileStorage implements FileStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: config.credentials,
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: this.config.endpoint ? undefined : 'AES256',
      }),
    );
  }
}
