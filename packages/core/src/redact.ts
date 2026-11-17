/**
 * The redaction of the command lines that headroom keeps (H186). A command line or the name of a job can hold a secret.
 * Examples are `GITHUB_TOKEN=... gh pr list`, `curl -u admin:...` and `mysql --password=...`. headroom stores and
 * shows each such text only after this redaction. Thus the database, the reap logs, the alerts and the dashboard hold no
 * secret of a command line.
 *
 * The shapes come from the home of redaction (`@mark1russell7/text/redact`). The tokens of known services are found by
 * their shape. The other secrets are found by their context. The contexts are a parameter or a flag with the name of
 * a secret, the user part of a URL, an Authorization header and `curl -u`. A match keeps the name. The value gets a mark.
 */
import { CONTEXT_SHAPES, redactSecretShapes, SECRET_SHAPES, type SecretShape } from "@mark1russell7/text/redact";
import type { JobKey } from "./predict.ts";

/** The shapes of a secret in a command line (H186): the shapes of tokens, then the shapes of a context. */
export const COMMAND_SHAPES: readonly SecretShape[] = Object.freeze([...SECRET_SHAPES, ...CONTEXT_SHAPES]);

/**
 * This function gives a command line or the name of a job with the mark `[secret]` in place of each secret (H186). The
 * rest of the text does not change. A second pass changes nothing.
 */
export function redactCommand(text: string): string {
  return redactSecretShapes(text, { shapes: COMMAND_SHAPES });
}

/** This function gives a job key with its command redacted (H186). The other fields of a key hold no command text. */
export function redactKey(key: JobKey): JobKey {
  const command = redactCommand(key.command);
  return command === key.command ? key : { ...key, command };
}
