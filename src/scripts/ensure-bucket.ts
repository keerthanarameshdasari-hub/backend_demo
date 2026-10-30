/**
 * One-off job: create the S3 bucket if it doesn't exist. docker-compose runs
 * it against MinIO before the API starts. Safe to run repeatedly.
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { InvalidEnvironmentError, loadEnv } from '../config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
        : undefined,
  });

  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
      console.log(`Bucket ${env.S3_BUCKET} already exists`);
      return;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) {
        await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
        console.log(`Created bucket ${env.S3_BUCKET}`);
        return;
      }
      // Storage not up yet: retry for ~30s.
      if (attempt >= 30) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof InvalidEnvironmentError ? error.message : (error as Error).name);
  process.exit(1);
});
