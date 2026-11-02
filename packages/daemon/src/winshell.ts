/**
 * The command line of a command on Windows, for `spawn`.
 *
 * - A program (`.exe` or `.com`) starts directly. Node quotes its arguments with the rules of the C runtime.
 * - Each other command goes to `cmd.exe /d /s /c`. This is a batch file (for example `pnpm.cmd`), a command of cmd, or a command that is not found.
 * - For cmd, each argument gets quotes, and each special character gets a caret (`^`). Thus `&`, `|`, `>`, `%` and `^` stay in the argument.
 * - A batch file reads its arguments a second time, so each special character gets a second caret.
 *
 * The rules are those of the package `cross-spawn`. This file uses no package, and only the types that Node can remove, so the bridge can import it when Node starts the bridge directly.
 */
import { statSync } from "node:fs";
import { win32 } from "node:path";

/** The special characters of cmd. */
const META = /[()\][%!^"`<>&|;, *?]/g;

/** The extensions of a program that starts without cmd. */
const PROGRAMS = new Set([".exe", ".com"]);

/** The extensions of a batch file. */
const BATCH = new Set([".cmd", ".bat"]);

/** The extensions of a command when the environment has no `PATHEXT`. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** The command that `spawn` starts: the file, the arguments, and the option `windowsVerbatimArguments`. */
export interface WindowsCommand {
  readonly file: string;
  readonly args: string[];
  readonly verbatim: boolean;
}

/** The data that finds a command: the environment, the current folder and a test for a file. */
export interface FindOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly isFile?: (path: string) => boolean;
}

/** This function quotes one argument with the rules of the C runtime. It doubles each backslash before a quote and at the end. */
export function quoteArgument(arg: string): string {
  const inner = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${inner}"`;
}

/** This function puts a caret before each special character of cmd. */
export function caretEscape(text: string): string {
  return text.replace(META, "^$&");
}

/** This function gives one argument for the command line of cmd. A batch file gets two carets, because it reads the argument two times. */
export function cmdArgument(arg: string, batch: boolean): string {
  const once = caretEscape(quoteArgument(arg));
  return batch ? caretEscape(once) : once;
}

/** This function gives the value of a variable of the environment. Windows ignores the case of the name. */
function variable(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFileOnDisk(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * This function finds the file of a command as cmd does. It looks in the current folder and then in `PATH`, with each extension of `PATHEXT`.
 * It gives `undefined` when no file matches.
 */
export function findCommand(name: string, options: FindOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const isFile = options.isFile ?? isFileOnDisk;
  const extensions = (variable(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").filter((ext) => ext !== "");
  const names = [...(win32.extname(name) === "" ? [] : [name]), ...extensions.map((ext) => name + ext.toLowerCase())];
  const located = /[\\/]/.test(name) || win32.isAbsolute(name);
  const folders = located
    ? [cwd]
    : [cwd, ...(variable(env, "PATH") ?? "").split(win32.delimiter).map((dir) => dir.replace(/"/g, "")).filter((dir) => dir !== "")];
  for (const folder of folders) {
    for (const candidate of names) {
      const path = win32.resolve(folder, candidate);
      if (isFile(path)) return path;
    }
  }
  return undefined;
}

/**
 * This function gives the file and the arguments that `spawn` starts for a command on Windows.
 * Pass `verbatim` as the option `windowsVerbatimArguments` of `spawn`.
 */
export function windowsCommand(command: readonly string[], options: FindOptions = {}): WindowsCommand {
  const [name = "", ...args] = command;
  const found = findCommand(name, options);
  const extension = found === undefined ? "" : win32.extname(found).toLowerCase();
  if (found !== undefined && PROGRAMS.has(extension)) return { file: found, args, verbatim: false };
  const batch = BATCH.has(extension);
  const line = [caretEscape(name), ...args.map((arg) => cmdArgument(arg, batch))].join(" ");
  const shell = variable(options.env ?? process.env, "COMSPEC") ?? "cmd.exe";
  return { file: shell, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}
