/** Credential ids (§A.4 "Ids", §A.5 "Credentials"). */

/** `credential:<owner>.<name>`, lowercase letters, digits and underscores. */
export const CREDENTIAL_ID_PATTERN = /^credential:[a-z0-9_]+\.[a-z0-9_]+$/;

/** The model credential with the `api_key` login (§A.5 "Model login"). */
export const MODEL_API_KEY = 'credential:model.api_key';

/** The Telegram bot token, required when Telegram is used (§F.1). */
export const TELEGRAM_BOT_TOKEN = 'credential:telegram.bot_token';

export class InvalidCredentialIdError extends Error {
  constructor() {
    // The given text is not repeated: a user may type a secret value where an id is expected.
    super(
      'The credential id is not valid. A credential id has the form credential:<owner>.<name>, ' +
        'with lowercase letters, digits and underscores, such as credential:telegram.bot_token.',
    );
    this.name = 'InvalidCredentialIdError';
  }
}

export function isCredentialId(id: unknown): id is string {
  return typeof id === 'string' && CREDENTIAL_ID_PATTERN.test(id);
}

export function assertCredentialId(id: unknown): asserts id is string {
  if (!isCredentialId(id)) throw new InvalidCredentialIdError();
}

/** Throws when a value cannot be stored. The message never contains the value. */
export function assertStorableValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('A secret value must be a string.');
  if (value.trim() === '') throw new Error('A secret value cannot be empty.');
}
