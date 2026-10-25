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

/** This function quotes one argument with the rules of the C runtime. */
export declare function quoteArgument(arg: string): string;

/** This function puts a caret before each special character of cmd. */
export declare function caretEscape(text: string): string;

/** This function gives one argument for the command line of cmd. A batch file gets two carets. */
export declare function cmdArgument(arg: string, batch: boolean): string;

/** This function finds the file of a command as cmd does, or gives `undefined`. */
export declare function findCommand(name: string, options?: FindOptions): string | undefined;

/** This function gives the file and the arguments that `spawn` starts for a command on Windows. */
export declare function windowsCommand(command: readonly string[], options?: FindOptions): WindowsCommand;
