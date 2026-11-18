import { describe, expect, it } from "vitest";
import { acrossLines, helperCommandLine, pendingLine, runningJobs, systemdArg, systemdUnit, windowsArg, windowsTaskXml, type ServiceCommand } from "./service.ts";

const command: ServiceCommand = {
  node: "C:\\Program Files\\nodejs\\node.exe",
  nodeOptions: ["--title=headroom-daemon"],
  cli: "C:\\Users\\a & b\\headroom\\cli.ts",
  args: ["serve", "--background", "--log", "C:\\Users\\a & b\\.headroom\\daemon.log"],
};

describe("windowsArg", () => {
  it("keeps a plain argument", () => expect(windowsArg("serve")).toBe("serve"));
  it("quotes spaces and doubles a final backslash", () => expect(windowsArg("C:\\a b\\")).toBe('"C:\\a b\\\\"'));
  it("escapes a quote", () => expect(windowsArg('say "hi"')).toBe('"say \\"hi\\""'));
  it("quotes an empty argument", () => expect(windowsArg("")).toBe('""'));
  it("doubles backslashes before a quote", () => expect(windowsArg('a\\\\"b c')).toBe('"a\\\\\\\\\\"b c"'));
  it("keeps backslashes in the middle", () => expect(windowsArg("a\\b c")).toBe('"a\\b c"'));
  it("is linear for a long run of backslashes", () => {
    const start = performance.now();
    const quoted = windowsArg(` ${"\\".repeat(200_000)}x`);
    expect(quoted.length).toBe(200_004);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("windowsTaskXml", () => {
  const text = windowsTaskXml(command, "HOST\\mark", 3, new Date("2026-10-19T21:30:00.123Z"));
  it("starts Node through a hidden console", () => {
    expect(text).toMatch(/<Command>.*conhost\.exe<\/Command>/);
    expect(text).toContain(
      "<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; --title=headroom-daemon &quot;C:\\Users\\a &amp; b\\headroom\\cli.ts&quot; serve --background",
    );
  });
  it("starts at logon, again when it stops, and one copy only", () => {
    expect(text).toContain("<UserId>HOST\\mark</UserId>");
    expect(text).toContain("<LogonTrigger>");
    expect(text).toContain("<StartBoundary>2026-10-19T21:30:00Z</StartBoundary>");
    expect(text).toContain("<Interval>PT3M</Interval>");
    expect(text).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(text).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });
});

describe("helperCommandLine", () => {
  const line = helperCommandLine(4242, command);
  it("runs the restart of the CLI after the daemon stops, with its own title", () => {
    expect(line).toMatch(/^"C:\\Program Files\\nodejs\\node\.exe" --title=headroom-restart "C:\\Users\\a & b\\headroom\\cli\.ts" service restart --after 4242 --log /);
    expect(line).not.toContain("headroom-daemon");
  });
});

describe("pendingLine", () => {
  it("tells the time of the request in UTC", () =>
    expect(pendingLine({ askedAt: Date.parse("2026-10-24T21:05:30Z") })).toBe("A restart waits for an idle queue (asked at 21:05 UTC)."));
});

describe("systemdUnit", () => {
  it("quotes the arguments and restarts after a failure", () => {
    const unit = systemdUnit({ node: "/usr/bin/node", nodeOptions: ["--title=headroom-daemon"], cli: "/home/m/my repo/cli.ts", args: ["serve", "--log", "/tmp/50%.log"] });
    expect(unit).toContain('ExecStart=/usr/bin/node --title=headroom-daemon "/home/m/my repo/cli.ts" serve --log /tmp/50%%.log');
    expect(unit).toContain("Restart=on-failure");
  });
  it("escapes a backslash and a quote", () => expect(systemdArg('a\\"b')).toBe('"a\\\\\\"b"'));
});

describe("the jobs across a restart (H202)", () => {
  const leases = [
    { id: "a1", job: "build", pid: 10, state: "granted" },
    { id: "a2", job: "serve", pid: 11, state: "granted" },
    { id: "w1", job: "later", pid: 12, state: "waiting" },
    { id: "g1", job: "no-process", pid: null, state: "granted" },
    { id: "r1", job: "done", pid: 13, state: "released" },
  ] as const;

  it("takes the granted leases with a process, and no other lease", () => {
    expect(runningJobs(leases)).toEqual([
      { id: "a1", job: "build", pid: 10 },
      { id: "a2", job: "serve", pid: 11 },
    ]);
  });

  it("has no line when no job runs", () => {
    expect(acrossLines([], () => true)).toEqual({ before: null, after: null });
  });

  it("names the jobs before the restart, and tells that each still runs after it", () => {
    const lines = acrossLines(runningJobs(leases), () => true);
    expect(lines.before).toBe("2 jobs run across the restart: build (process 10), serve (process 11).");
    expect(lines.after).toBe("The 2 jobs that ran before the restart still run.");
  });

  it("names each job that ended in the restart, with its lease for the exit", () => {
    expect(acrossLines(runningJobs(leases), (pid) => pid !== 11).after).toBe(
      "1 of 2 jobs still run. These jobs ended in the restart: serve (lease a2). The command headroom job <lease> tells the exit of each.",
    );
  });
});
