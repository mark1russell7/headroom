/**
 * The command fixtures of the hook (H55, H52, H194). The test of the rating, the test of the lease form and the golden
 * verdicts of the old process hook (`hook-golden.json` in this folder) use the same lists. The lists come from the test of the process
 * hook at ba692cc. Each list keeps its order, because the golden verdicts go by index.
 */

/** The commands that a word in their text rated as heavy before H55: the rating gives light for each. */
export const FALSE_CASES: readonly string[] = [
  // The false case of 2026-11-04: the refusal also told the session to put headroom run in front of a grep.
  'git grep -E "vitest|jest" origin/main',
  "git grep -E 'vitest|jest' origin/main",
  "git -C packages/core grep vitest",
  // A word in a quoted string.
  'git commit -m "fix the vitest config"',
  "git commit -m 'pnpm test passes now'",
  'gh pr create --title "docker build fix" --body "pnpm test passes"',
  // A word in a comment.
  "git status # do not start vitest here",
  // A text reader, whatever its arguments say.
  "grep -rn vitest packages",
  "rg vitest packages",
  "sed -n 1,5p vitest.config.ts",
  "cat vitest.config.ts",
  "echo vitest",
  "echo pnpm test",
  "head -5 jest.config.js",
  "tail -5 pytest.log",
  "ls vitest.config.ts",
  "Select-String -Path a.txt -Pattern vitest",
  "Get-Content vitest.config.ts",
  "get-content vitest.config.ts",
  "cd app && git grep vitest | head -5",
  "grep.exe vitest a.txt",
  'FOO=1 grep "pnpm test" a.txt',
  "if grep -q vitest a.txt; then echo vitest; fi",
  // A line that continues on the next line stays one part.
  "echo a \\\n  vitest",
  // The body of a here-document that a text program reads (11-15: a PR body that named vitest was refused).
  "cat > a.md <<'MSG'\n- `vitest related` on two files\npnpm test passes\nMSG",
  'gh pr create --title t --body-file - <<"EOF"\npnpm test\nvitest run\nEOF',
  "git commit -F - <<-'EOF'\n\tvitest run\n\tEOF",
  "cat <<EOF > a.md\npnpm test passes\nEOF",
  "cat <<\\EOF > a.md\n`vitest run`\nEOF",
  "cat <<'A' <<'B'\nvitest\nA\npnpm test\nB",
  "cat > a.md <<'MSG'\r\nvitest run\r\nMSG\r\ngit status",
  "cat <<'EOF' | tee a.md\nvitest run\nEOF",
  // A here-document in a command substitution: a quote in its body does not close the string.
  "git commit -m \"$(cat <<'EOF'\nthe \"vitest\nvitest run\nEOF\n)\"",
];

/** The commands that stay heavy. */
export const HEAVY_CASES: readonly string[] = [
  "pnpm test",
  "npx playwright test e2e/x.spec.ts",
  // A shell runs its argument, so the quoted text counts.
  'bash -c "pnpm test"',
  "sh -c 'vitest run'",
  'bash -lc "cd app && pnpm test"',
  'powershell -Command "pnpm test"',
  'powershell.exe -NoProfile -Command "pnpm test"',
  "pwsh -Command 'vitest run'",
  'cmd /c "pnpm test"',
  'cmd.exe /s /c "pnpm test"',
  '"C:/Program Files/Git/bin/bash.exe" -c "pnpm test"',
  // Each part has its own rating.
  "grep vitest a.txt && pnpm test",
  "echo vitest; pnpm test",
  "cat a.txt | xargs vitest run",
  "echo start\npnpm test",
  "echo start & pnpm test",
  "(cd app && pnpm test)",
  "if pnpm test; then echo ok; fi",
  // A quote with no closing quote does not hide a command.
  "git status it's && pnpm test",
  // A comment with an apostrophe does not hide the next line.
  "# do not stop, it's a gate\npnpm test\n# it's the end",
  // A program that is not a text reader keeps its unquoted words.
  "git log --grep vitest",
  // A here-document: a heavy part on the line of the operator or after the body counts.
  "cat <<'MSG' > a.md && pnpm test\nbody\nMSG",
  "cat > a.md <<'MSG'\nbody\nMSG\npnpm test",
  // A shell or an interpreter reads its body as commands.
  "bash <<'EOF'\npnpm test\nEOF",
  "sh -s <<EOF\nvitest run\nEOF",
  // An unquoted delimiter: the shell runs each substitution in the body.
  "cat <<EOF\n$(pnpm test)\nEOF",
  "cat <<EOF\n`vitest run`\nEOF",
  // A pipe takes the body to a shell.
  "cat <<'EOF' | bash\npnpm test\nEOF",
  "cat <<'EOF' | tee a.sh | sh\nvitest run\nEOF",
  // A body that no line closes stays in the rating.
  "cat <<'MSG'\nvitest run",
  "git commit -m \"$(cat <<'EOF'\nthe \"vitest\nEOF\n)\" && pnpm test",
  // A shift in arithmetic and a here-string are not here-documents.
  "echo $((1 << 2))\npnpm test\n2",
  "cat <<< x\npnpm test",
];

/** Each command line and its form under a lease: `headroom run --mem auto --` in front of each heavy part (H52). */
export const LEASE_CASES: readonly (readonly [string, string])[] = [
  ["pnpm test", "headroom run --mem auto -- pnpm test"],
  ["cd app && CI=1 pnpm exec vitest run | tail -5", "cd app && CI=1 headroom run --mem auto -- pnpm exec vitest run | tail -5"],
  ["git pull; npx playwright test e2e/x.spec.ts", "git pull; headroom run --mem auto -- npx playwright test e2e/x.spec.ts"],
  ["git grep -E \"vitest|jest\" origin/main && pnpm test", "git grep -E \"vitest|jest\" origin/main && headroom run --mem auto -- pnpm test"],
  ["git commit -m \"pnpm test; vitest\" && CI=1 pnpm build", "git commit -m \"pnpm test; vitest\" && CI=1 headroom run --mem auto -- pnpm build"],
  ["grep vitest a.txt | bash -c \"pnpm test\"", "grep vitest a.txt | headroom run --mem auto -- bash -c \"pnpm test\""],
  ["NAME=\"a b\" pnpm test 2>&1 | tail -5", "NAME=\"a b\" headroom run --mem auto -- pnpm test 2>&1 | tail -5"],
  ["(cd app && pnpm test)", "(cd app && headroom run --mem auto -- pnpm test)"],
  ["cat > a.md <<'MSG'\nvitest run\nMSG\npnpm test", "cat > a.md <<'MSG'\nvitest run\nMSG\nheadroom run --mem auto -- pnpm test"],
  ["node - <<'JS'\n// the gate runs vitest run\nJS", "headroom run --mem auto -- node - <<'JS'\n// the gate runs vitest run\nJS"],
  ["cd app && python3 - <<'PY'\nimport pytest\nPY", "cd app && headroom run --mem auto -- python3 - <<'PY'\nimport pytest\nPY"],
  ["cat <<'EOF' | node\n// vitest run\nEOF", "cat <<'EOF' | headroom run --mem auto -- node\n// vitest run\nEOF"],
  ["bash <<'SH'\ncd app\nnode - <<'JS'\n// vitest run\nJS\nSH", "bash <<'SH'\ncd app\nheadroom run --mem auto -- node - <<'JS'\n// vitest run\nJS\nSH"],
  ["python3 - <<'PY'\nnode - <<'JS'\n// vitest run\nJS\nPY", "headroom run --mem auto -- python3 - <<'PY'\nnode - <<'JS'\n// vitest run\nJS\nPY"],
  ["bash <<'EOF'\ncd app\npnpm test\nEOF", "bash <<'EOF'\ncd app\nheadroom run --mem auto -- pnpm test\nEOF"],
  ["cat <<'EOF' | sh\nvitest run\nEOF", "cat <<'EOF' | sh\nheadroom run --mem auto -- vitest run\nEOF"],
  ["cat <<EOF\n$(pnpm test)\nEOF", "cat <<EOF\n$(headroom run --mem auto -- pnpm test)\nEOF"],
];

/** The commands of the verdict tests of the process hook: light, heavy and under `headroom run`. */
export const RUN_CASES: readonly string[] = [
  "git status",
  "pnpm test",
  "cd packages/core && pnpm exec vitest run",
  "npx playwright test e2e",
  "pnpm test",
  "headroom run --mem 2g -- pnpm test",
  "pnpm test",
  "git grep -E \"vitest|jest\" origin/main",
  "git commit -m \"fix the vitest config\"",
  "echo vitest",
  "git grep -E \"vitest|jest\" origin/main && pnpm test",
  // H208: a detached run, a run with a wait shorter than the default timeout, and --detach as an argument of the command.
  "headroom run --detach --job tests --mem 2g -- pnpm test",
  "headroom run --wait 1m --mem 2g -- pnpm test",
  "headroom run --mem 2g -- pnpm test --detach",
];

/**
 * The commands that name a file of a test runner (H221): the rating gives light for each. On 2026-11-21, the hook refused
 * the first three until they went under a lease, and the lease of the commit waited 1 h for 1600 MB. The golden verdicts
 * of the old process hook do not have these lists, because that hook rated each of them as heavy.
 */
export const RUNNER_FILE_CASES: readonly string[] = [
  "git show origin/main:packages/x/vitest.config.ts",
  "gh api repos/o/r/contents/packages/x/vitest.config.ts?ref=main",
  "git commit -F msg -- packages/ui/vitest.slow.config.ts",
  "git diff origin/main -- packages/core/vitest.config.ts jest.config.js",
  "git add packages/site/vitest.setup.ts pytest.ini",
  "git show HEAD:node_modules/vitest/package.json",
  "node scripts/check.ts --config=vitest.config.ts",
  "vitest --version",
  "npx jest --version",
];

/** The commands that start a test runner by a path, a version or a launcher (H221): each stays heavy. */
export const RUNNER_CASES: readonly string[] = [
  "node_modules/.bin/vitest run",
  "./node_modules/.bin/jest --ci",
  "C:\\repo\\node_modules\\.bin\\vitest.cmd run",
  "node node_modules/vitest/vitest.mjs run",
  "npx vitest@3.2.4 run",
  "pnpm exec vitest run --config vitest.slow.config.ts",
  "pnpm vitest related src/a.ts",
  "timeout 200 vitest run",
  "cross-env CI=1 jest",
  "python -m pytest tests",
  "$(npm bin)/vitest run",
  "sh -c 'cd app && vitest run'",
];

/** Each command of the golden verdicts, in a fixed order with no duplicate. */
export const VERDICT_COMMANDS: readonly string[] = [...new Set([...RUN_CASES, ...FALSE_CASES, ...HEAVY_CASES, ...LEASE_CASES.map(([input]) => input)])];
