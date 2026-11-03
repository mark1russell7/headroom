/**
 * The browser module for the Node built-ins that the core imports (`vite.config.ts`). The simulator uses only
 * `randomUUID`. Each other function throws, because the simulator must not read files or the home folder.
 */

/** This function gives a new random UUID from the Web Crypto API of the browser. */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

function absent(name: string): () => never {
  return () => {
    throw new Error(`${name} is not available in the browser`);
  };
}

export const readFileSync: () => never = absent("readFileSync");
export const readdirSync: () => never = absent("readdirSync");
export const realpathSync: () => never = absent("realpathSync");
export const statSync: () => never = absent("statSync");
export const homedir: () => never = absent("homedir");
export const join: () => never = absent("join");
