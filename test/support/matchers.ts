/**
 * Custom matchers that make a broken domain rule easy to spot in test output.
 * Loaded through `setupFilesAfterEnv` in every Jest config.
 *
 *   await expect(service.topUp(...)).toBeRefusedWith(KycRequiredError, 'top-ups need approved KYC');
 *
 * When the rule is broken (the call succeeds, or fails some other way) the
 * failure names the rule, the expected error, and what actually happened.
 */
import { DomainError } from '../../src/domain';

type ErrorClass = abstract new (...args: never[]) => Error;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      /** The promise rejects with an instance of `errorClass`. `rule` is a plain-words name for the domain rule. */
      toBeRefusedWith(errorClass: ErrorClass, rule: string): Promise<R>;
    }
  }
}

expect.extend({
  async toBeRefusedWith(this: jest.MatcherContext, received: Promise<unknown>, errorClass: ErrorClass, rule: string) {
    const { printReceived, matcherHint } = this.utils;
    const header = `${matcherHint('.toBeRefusedWith', 'promise', errorClass.name)}\n\nDomain rule: ${rule}\n\n`;

    let value: unknown;
    try {
      value = await received;
    } catch (error) {
      if (error instanceof errorClass) {
        return { pass: true, message: () => `${header}Expected the call NOT to be refused with ${errorClass.name}, but it was.` };
      }
      const what =
        error instanceof DomainError
          ? `${error.name} (${error.code}): ${error.message}`
          : error instanceof Error
            ? `${error.name}: ${error.message}`
            : printReceived(error);
      return {
        pass: false,
        message: () => `${header}RULE BROKEN: expected the call to be refused with ${errorClass.name}, but it failed with ${what}`,
      };
    }
    return {
      pass: false,
      message: () =>
        `${header}RULE BROKEN: expected the call to be refused with ${errorClass.name}, but it succeeded and returned:\n\n  ${printReceived(value)}`,
    };
  },
});

export {};
