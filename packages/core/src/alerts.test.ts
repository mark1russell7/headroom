import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, detect, diskLevel, type AlertInput } from "./alerts.ts";
import type { Lease } from "./broker.ts";
import type { ServiceHealth } from "./services.ts";
import type { OwnerKind, ProcessInfo, TcpConnection, TcpTable } from "./types.ts";

const p = (pid: number, ppid: number, name: string, privateMb: number): ProcessInfo => ({ pid, ppid, name, privateMb, workingMb: privateMb });
const memory = { totalMb: 28_000, availableMb: 8000, commitMb: 30_000, commitLimitMb: 80_000, kernelPagedMb: 900, kernelNonpagedMb: 1000 };

const lease = (pid: number): Lease => ({
  id: "l1", holder: "graph", job: "vitest", amounts: { memory: 6000 }, priority: 0, pid, ttlMs: 0, state: "granted",
  requestedAt: 0, grantedAt: 0, endedAt: null, heartbeatAt: 0, reason: null, peakMb: null,
});

function input(processes: ProcessInfo[], owners: Record<number, [string, OwnerKind]>, extra: Partial<AlertInput> = {}): AlertInput {
  return {
    memory,
    processes,
    ownerOf: new Map(Object.entries(owners).map(([pid, [owner]]) => [Number(pid), owner])),
    kindOf: new Map(Object.values(owners).map(([owner, kind]) => [owner, kind])),
    leases: [],
    ...extra,
  };
}

describe("detect", () => {
  it("flags a large process with no lease, and not one under a lease or in Docker", () => {
    const processes = [p(1, 0, "claude.exe", 500), p(2, 1, "grep.exe", 16_000), p(3, 1, "node.exe", 1000), p(4, 3, "vitest.exe", 6000), p(5, 0, "vmmemWSL", 8000)];
    const owners: Record<number, [string, OwnerKind]> = {
      1: ["session:graph", "session"], 2: ["session:graph", "session"], 3: ["session:graph", "session"], 4: ["session:graph", "session"], 5: ["docker", "docker"],
    };
    const alerts = detect(input(processes, owners, { leases: [lease(3)] }));
    expect(alerts.map((alert) => alert.id)).toEqual(["runaway:2"]);
    expect(alerts[0]?.message).toBe("grep.exe (2) of session:graph holds 15.6 GB with no lease");
  });

  it("flags a large orphan with no owner", () => {
    const alerts = detect(input([p(7, 99, "grep.exe", 2000), p(8, 99, "M365Copilot.exe", 90)], { 7: ["other", "other"], 8: ["other", "other"] }));
    expect(alerts.map((alert) => alert.id)).toEqual(["orphan:7"]);
  });

  it("flags low memory, a commit near its limit, and a pool that grows", () => {
    const low = { ...memory, availableMb: 400, commitMb: 75_000, kernelNonpagedMb: 1800 };
    const alerts = detect({ ...input([], {}), memory: low, poolHourAgoMb: 1000 });
    expect(alerts.map((alert) => alert.kind)).toEqual(["memory", "commit", "pool"]);
    expect(alerts[2]?.message).toContain("800 MB more than one hour ago");
  });

  it("flags a large or fast-growing paged pool", () => {
    const big = detect({ ...input([], {}), memory: { ...memory, kernelPagedMb: 4600 } });
    expect(big.map((alert) => alert.id)).toEqual(["pool:paged"]);
    const fast = detect({ ...input([], {}), memory: { ...memory, kernelPagedMb: 2900 }, pagedHourAgoMb: 2200 });
    expect(fast[0]?.message).toContain("The paged kernel pool is 2.8 GB, 700 MB more than one hour ago");
  });

  it("flags a session with very many processes", () => {
    const busy = detect({ ...input([], {}), load: { processes: 1240, userObjects: 9100, gdiObjects: 15000 } });
    expect(busy.map((alert) => alert.id)).toEqual(["desktop"]);
    expect(busy[0]?.message).toContain("1240 processes run in this session (9100 USER and 15000 GDI objects)");
    expect(detect({ ...input([], {}), load: { processes: 504, userObjects: 2685, gdiObjects: 4445 } })).toEqual([]);
  });

  it("gives nothing on a quiet computer", () => expect(detect({ ...input([], {}), poolHourAgoMb: 980 })).toEqual([]));

  it("warns about a drive with little free space", () => {
    const alerts = detect({ ...input([], {}), disks: [{ mount: "D:", freeMb: 12_600, totalMb: 200_000 }] });
    expect(alerts).toEqual([
      { id: "disk:D:", kind: "disk", subject: "drive D:", pid: null, mb: 12_600, severity: "warning", message: "Drive D: has 12.3 GB free of 195 GB." },
    ]);
  });

  it("flags a nearly full drive as critical, with the loss of the last hour", () => {
    const disks = [{ mount: "C:", freeMb: 4300, totalMb: 974_848, droppedMb: 39_014, windowMinutes: 60 }, { mount: "D:", freeMb: 125_000, totalMb: 200_000 }];
    const alerts = detect({ ...input([], {}), disks });
    expect(alerts.map((alert) => [alert.id, alert.severity])).toEqual([["disk:C:", "critical"]]);
    expect(alerts[0]?.message).toBe("Drive C: has 4.2 GB free of 952 GB, 38.1 GB less than one hour ago.");
    const recent = detect({ ...input([], {}), disks: [{ ...disks[0]!, windowMinutes: 12 }] });
    expect(recent[0]?.message).toContain("38.1 GB less than 12 minutes ago.");
  });

  it("names the 3 owners that wrote most in the last hour above 100 MB in a disk alert, and keeps its id and severity", () => {
    const disks = [{ mount: "C:", freeMb: 4300, totalMb: 974_848, droppedMb: 39_014, windowMinutes: 60 }];
    const writes = [
      { owner: "mcp:vex", kind: "mcp" as const, mbPerMin: 2, mbLastHour: 2150 },
      { owner: "session:graph", kind: "session" as const, mbPerMin: 500, mbLastHour: 31_949 },
      { owner: "docker", kind: "docker" as const, mbPerMin: 1, mbLastHour: 400 },
      { owner: "system", kind: "system" as const, mbPerMin: 1, mbLastHour: 120 },
      { owner: "editor", kind: "editor" as const, mbPerMin: 0, mbLastHour: 99 },
    ];
    const alerts = detect({ ...input([], {}), disks, writes });
    expect(alerts).toStrictEqual([
      {
        id: "disk:C:", kind: "disk", subject: "drive C:", pid: null, mb: 4300, severity: "critical",
        message: "Drive C: has 4.2 GB free of 952 GB, 38.1 GB less than one hour ago. Most writes in the last hour: session:graph 31.2 GB, mcp:vex 2.1 GB, docker 400 MB.",
      },
    ]);
    // No owner above 100 MB: the message is the same as before.
    const quiet = detect({ ...input([], {}), disks, writes: writes.slice(4) });
    expect(quiet[0]?.message).toBe("Drive C: has 4.2 GB free of 952 GB, 38.1 GB less than one hour ago.");
  });

  it("gives no disk alert above the limits, and scales the limits down on a small drive", () => {
    expect(detect({ ...input([], {}), disks: [{ mount: "C:", freeMb: 265_000, totalMb: 774_000 }, { mount: "D:", freeMb: 20_481, totalMb: 200_000 }] })).toEqual([]);
    // A drive of 30 GB warns below 20% (6 GB) and is critical below 5% (1.5 GB).
    expect(diskLevel({ mount: "E:", freeMb: 8000, totalMb: 30_720 })).toBeNull();
    expect(diskLevel({ mount: "E:", freeMb: 5000, totalMb: 30_720 })).toBe("warning");
    expect(diskLevel({ mount: "E:", freeMb: 1000, totalMb: 30_720 })).toBe("critical");
  });

  it("gives each alert of before with the same fields, and no severity outside the disk alerts", () => {
    const low = { ...memory, availableMb: 400.4, commitMb: 75_000, kernelNonpagedMb: 3500, kernelPagedMb: 4600 };
    const alerts = detect({ ...input([], {}), memory: low, poolHourAgoMb: 2800, pagedHourAgoMb: 4700, load: { processes: 1240, userObjects: null, gdiObjects: null } });
    expect(alerts).toStrictEqual([
      { id: "memory", kind: "memory", subject: "memory", pid: null, mb: 400, message: "Only 400 MB of memory is available" },
      { id: "commit", kind: "commit", subject: "commit", pid: null, mb: 75_000, message: "The commit charge is 73.2 GB of its limit 78.1 GB" },
      { id: "pool", kind: "pool", subject: "non-paged pool", pid: null, mb: 3500, message: "The non-paged kernel pool is 3.4 GB, 700 MB more than one hour ago. A driver can leak it." },
      { id: "pool:paged", kind: "pool", subject: "paged pool", pid: null, mb: 4600, message: "The paged kernel pool is 4.5 GB. A file system filter can leak it." },
      {
        id: "desktop", kind: "desktop", subject: "session", pid: null, mb: 0,
        message: "1240 processes run in this session. With this many, a new process can stop at its start with 0xC0000142, because the desktop heap runs out.",
      },
    ]);
  });

  it("gives one alert for each process: a large orphan with no lease is a runaway", () => {
    const alerts = detect(input([p(7, 99, "grep.exe", 6000)], { 7: ["other", "other"] }));
    expect(alerts).toStrictEqual([{ id: "runaway:7", kind: "runaway", subject: "grep.exe (7)", pid: 7, mb: 6000, message: "grep.exe (7) of other holds 5.9 GB with no lease" }]);
    const orphan = detect(input([p(7, 99, "grep.exe", 2000)], { 7: ["other", "other"] }));
    expect(orphan[0]).toStrictEqual({ id: "orphan:7", kind: "orphan", subject: "grep.exe (7)", pid: 7, mb: 2000, message: "grep.exe (7) holds 2.0 GB, and its parent (99) stopped" });
  });

  describe("ports", () => {
    /** This function gives a TCP table with this many dynamic connections of each process, and this many in TIME_WAIT with no process. */
    function tcp(byPid: Record<number, number>, timeWait: number): TcpTable {
      const connections: TcpConnection[] = [{ localPort: 3000, state: "listen", pid: 1, address: "0.0.0.0" }];
      let port = 1000;
      for (const [pid, count] of Object.entries(byPid)) for (let index = 0; index < count; index++) connections.push({ localPort: port++, state: "established", pid: Number(pid) });
      for (let index = 0; index < timeWait; index++) connections.push({ localPort: port++, state: "time-wait", pid: 0 });
      // A connection outside the dynamic range does not count.
      connections.push({ localPort: 999, state: "established", pid: 1 });
      return { dynamic: { first: 1000, count: 1000 }, connections };
    }
    const owners: Record<number, [string, OwnerKind]> = {
      1: ["session:graph", "session"], 2: ["session:graph", "session"], 3: ["mcp:vex", "mcp"], 4: ["docker", "docker"], 5: ["system", "system"],
    };

    it("warns above 80% of the dynamic ports, and names the 3 owners with the most connections and the count in TIME_WAIT", () => {
      const alerts = detect(input([], owners, { tcp: tcp({ 1: 300, 2: 100, 3: 150, 4: 50, 5: 20 }, 190) }));
      expect(alerts).toStrictEqual([
        {
          id: "ports:tcp", kind: "ports", subject: "TCP ports", pid: null, mb: 0, severity: "warning",
          message:
            "810 of 1000 dynamic TCP ports are in use (81%), 190 of them in TIME_WAIT. Most connections: session:graph 400, mcp:vex 150, docker 50." +
            " When no dynamic port is free, new connections fail.",
        },
      ]);
    });

    it("is critical above 95%, and gives no alert at 80% or below", () => {
      const critical = detect(input([], owners, { tcp: tcp({ 3: 900 }, 51) }));
      expect(critical.map((alert) => [alert.id, alert.severity])).toEqual([["ports:tcp", "critical"]]);
      expect(critical[0]?.message).toContain("951 of 1000 dynamic TCP ports are in use (95%), 51 of them in TIME_WAIT. Most connections: mcp:vex 900.");
      expect(detect(input([], owners, { tcp: tcp({ 1: 600 }, 200) }))).toEqual([]);
      // With no process, the message names no owner.
      expect(detect(input([], owners, { tcp: tcp({}, 900) }))[0]?.message).toBe(
        "900 of 1000 dynamic TCP ports are in use (90%), 900 of them in TIME_WAIT. When no dynamic port is free, new connections fail.",
      );
    });

    it("uses the limits of the rules that the caller gives", () => {
      const strict = { ...DEFAULT_ALERT_RULES, portsWarnRatio: 0.5, portsCriticalRatio: 0.7 };
      expect(detect(input([], owners, { tcp: tcp({ 1: 600 }, 0) }), strict).map((alert) => alert.severity)).toEqual(["warning"]);
      expect(detect(input([], owners, { tcp: tcp({ 1: 701 }, 0) }), strict).map((alert) => alert.severity)).toEqual(["critical"]);
    });
  });

  it("uses the limits of the rules that the caller gives, and no commit alert without a commit limit", () => {
    const strict = { ...DEFAULT_ALERT_RULES, availableMb: 10_000, diskWarnMb: 300_000 };
    const alerts = detect({ ...input([], {}), disks: [{ mount: "C:", freeMb: 265_000, totalMb: 1_774_000 }] }, strict);
    expect(alerts.map((alert) => [alert.id, alert.severity])).toEqual([["memory", undefined], ["disk:C:", "warning"]]);
    expect(diskLevel({ mount: "C:", freeMb: 265_000, totalMb: 1_774_000 }, strict)).toBe("warning");
    expect(detect({ ...input([], {}), memory: { ...memory, commitMb: 9000, commitLimitMb: 0 } })).toEqual([]);
  });
});

describe("detect: services (H27)", () => {
  const at = Date.UTC(2026, 9, 24, 18, 45);
  const since = Date.UTC(2026, 9, 24, 18, 42);
  const health = (name: string, state: ServiceHealth["state"], checks: number, extra: Partial<ServiceHealth> = {}): ServiceHealth => ({
    name, type: name.startsWith("mcp:") ? "mcp" : name === "docker" ? "docker" : "url",
    title: name === "docker" ? "The Docker engine" : name.startsWith("mcp:") ? `The MCP server ${name.slice(4)}` : `The service ${name}`,
    target: null, critical: name === "docker" || name.startsWith("mcp:"), needs: null,
    state, latencyMs: null, checkedAt: at, since, checks, okAt: null, error: null, errorAt: null, ...extra,
  });
  const services = (...list: ServiceHealth[]): AlertInput => input([], {}, { services: list });

  it("gives a critical alert for Docker after two checks that are down, and none after one", () => {
    expect(detect(services(health("docker", "down", 1)))).toEqual([]);
    const docker = health("docker", "down", 2, { needs: "Containers such as Mongo and the graph tests need it." });
    const [alert] = detect(services(docker));
    expect(alert).toMatchObject({ id: "service:docker", kind: "service", subject: "docker", severity: "critical", pid: null, mb: 0 });
    expect(alert?.message).toBe(
      "The Docker engine does not answer since 18:42 UTC (3 min). Containers such as Mongo and the graph tests need it. headroom does not restart it.",
    );
  });

  it("gives a warning for a URL that is down, and names the last error of an MCP server that does not start", () => {
    const alerts = detect(services(health("fleet-site", "down", 2), health("mcp:vex", "down", 2, { error: "Error: Cannot find module 'zod'." })));
    expect(alerts.map((alert) => [alert.id, alert.severity])).toEqual([["service:fleet-site", "warning"], ["service:mcp:vex", "critical"]]);
    expect(alerts[1]?.message).toBe("The MCP server vex does not start: Error: Cannot find module 'zod'.");
  });

  it("gives no alert for an idle MCP server, for no Docker engine, or for a good service", () => {
    expect(detect(services(health("mcp:loom", "idle", 40), health("docker", "absent", 40), health("fleet-site", "ok", 40)))).toEqual([]);
  });

  it("gives a warning after three slow checks in a row", () => {
    expect(detect(services(health("docker", "slow", 2, { latencyMs: 1400 })))).toEqual([]);
    const [alert] = detect(services(health("docker", "slow", 3, { latencyMs: 1400 })));
    expect(alert).toMatchObject({ id: "service:docker", severity: "warning" });
    expect(alert?.message).toBe("The Docker engine answers slowly: 1400 ms at the last check, 3 slow checks in a row.");
    expect(detect(services(health("docker", "down", 2)), { ...DEFAULT_ALERT_RULES, serviceDownChecks: 3 })).toEqual([]);
  });

  it("flags an orphan whose parent ID is in use again by a newer process (H29)", () => {
    const at = (info: ProcessInfo, startedAt: number): ProcessInfo => ({ ...info, startedAt });
    const processes = [at(p(7, 99, "grep.exe", 2000), 5000), at(p(99, 1, "conhost.exe", 10), 9000)];
    expect(detect(input(processes, { 7: ["other", "other"], 99: ["other", "other"] })).map((alert) => alert.id)).toEqual(["orphan:7"]);
    expect(detect(input([at(p(7, 99, "grep.exe", 2000), 5000), at(p(99, 1, "bash.exe", 10), 4000)], { 7: ["other", "other"], 99: ["other", "other"] }))).toEqual([]);
  });

  describe("churn (H29)", () => {
    const starts = (perMinute: number, spanMs: number): AlertInput["starts"] => ({
      perMinute,
      exact: true,
      spanMs,
      owners: [
        { owner: "session:client", kind: "session", perMinute: 410, jobsPerMinute: 12, ownPerMinute: 398 },
        { owner: "session:organizer", kind: "session", perMinute: 120, jobsPerMinute: 0, ownPerMinute: 120 },
        { owner: "other", kind: "other", perMinute: 30, jobsPerMinute: 0, ownPerMinute: 30 },
        { owner: "system", kind: "system", perMinute: 5, jobsPerMinute: 0, ownPerMinute: 5 },
      ],
      jobs: [{ id: "L1", job: "coeval-063-test-compiler", holder: "client", owner: "session:client", processes: 9800, perMinute: 12 }],
    });

    it("warns when the computer starts more than 600 processes a minute for 10 minutes, and names the owners and the jobs", () => {
      const alerts = detect(input([], {}, { starts: starts(1450, 600_000) }));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ id: "churn", kind: "churn", subject: "process starts", severity: "warning", pid: null });
      expect(alerts[0]?.message).toBe(
        "Processes start at 1,450 a minute over the last 10 minutes. Most: session:client 410 (jobs 12, own commands 398, job coeval-063-test-compiler: 9,800 so far), " +
          "session:organizer 120, other 30. Leased jobs with the most starts: coeval-063-test-compiler of client 9,800 so far. " +
          "Each new process leaks kernel memory in the AMD display driver until it is updated (hub ask amd-driver).",
      );
    });

    it("gives no alert below the limit, or before the reads cover 10 minutes", () => {
      expect(detect(input([], {}, { starts: starts(590, 600_000) }))).toEqual([]);
      expect(detect(input([], {}, { starts: starts(1450, 300_000) }))).toEqual([]);
      expect(detect(input([], {}, { starts: starts(450, 600_000) }), { ...DEFAULT_ALERT_RULES, churnPerMinute: 400 }).map((alert) => alert.id)).toEqual(["churn"]);
    });
  });
});
