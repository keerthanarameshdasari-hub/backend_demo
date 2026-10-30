/** Stops the Testcontainers Postgres, if global-setup.ts started one. */
export default async function globalTeardown(): Promise<void> {
  await globalThis.__INT_POSTGRES__?.stop();
}
