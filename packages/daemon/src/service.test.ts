import { describe, expect, it } from "vitest";
import { helperCommandLine, pendingLine, systemdArg, systemdUnit, windowsArg, windowsTaskXml, type ServiceCommand } from "./service.ts";

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
