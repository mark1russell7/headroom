# Instructions for Claude

## The project

- headroom manages the memory and the processors of one computer for the jobs that run on it. `README.md` tells why.
- The plan and the status of each item are in `docs/ROADMAP.md`. Change it when an item starts, ships or gets blocked.
- The live tracker is the folder `~/git/fleet/artifacts/headroom-roadmap`. Its `artifact.json` gives the URL for each account.
- Change the roadmap file and the tracker together.
- The server contract of the client is `~/git/client/packages/documentation/SERVER-LAYERS.md`. headroom is an app of it.
- Do not write a listener, a signal handler, a health route or an RPC endpoint. Use `runProcedureHost`.
- Keep the daemon small. Its target is less than 60 MB of memory. Add no dependency without a reason.
- This repository has no `.mcp.json`. Each MCP server costs memory in each session.

## Writing style

Write all prose of this repository in the style of ASD-STE100 Simplified Technical English (STE). This prose is the README files, this file, the TSDoc comments and the text that the site shows. The linter [`ste-lint`](https://github.com/mark1russell7/ste-lint) examines it.

- After a change to prose, start `pnpm lint:ste` and correct each finding. CI fails when there is an error.
- Keep each instruction to 20 words or fewer, and each description to 25 words or fewer.
- Do not use the modal verbs (`should`, `may`, `might`, `would`), semicolons or Latin abbreviations (`e.g.`, `i.e.`, `etc.`).
- Use the active voice. Start each sentence of a doc comment with its subject: "This function returns the value", not "Returns the value".
- Put code, file names and commands in code font. The linter counts each code span as one word.
- Add a word to the glossary in `ste.config.json` only if it is a real technical term of the project.

## Packages

- Make a new package with `pnpm package add <name> --preset=<preset>`. Do not write `package.json` or `tsconfig.json` by hand.
- A package is a source package. Its `main` is `src/index.ts`, so other packages import its source.
- Each package has a `tsconfig.test.json`. `pnpm typecheck` checks the source and the tests.

## npm releases

- Do not publish to npm, and do not change npm settings. The owner and one named Claude session do all npm work.
- Do not edit `.github/workflows/release.yml` or `scripts/release/`.
- Is a package that is not on npm a block? Use `workspace:*`, or a `github:` specifier pinned to a commit.
- `RELEASING.md` tells how a release and a new package work.
