/**
 * The page of the simulator: the controls, the gauges of the computer, the queue, the timeline and the log. The page
 * draws a `View` of the simulator after each change.
 */

import "./style.css";
import { BURST, KINDS, MACHINES, machineOf, START } from "./catalog.ts";
import { Simulation, type Row, type View } from "./sim.ts";
import { timelineOf } from "./timeline.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no element #${id}`);
  return element as T;
};

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const gbText = (mb: number): string => `${(Math.max(0, mb) / 1024).toFixed(1)} GB`;
const cores = (n: number): string => `${n} ${n === 1 ? "core" : "cores"}`;

let sim = new Simulation(machineOf("laptop"));
let timer: number | undefined;

/** This function starts the page with the jobs of the start scenario, so the queue shows a wait at the first look. */
function begin(): void {
  for (const [kind, holder] of START) sim.add(kind, holder);
  sim.step(8);
}

function reset(): void {
  sim = new Simulation(machineOf(($("machine") as HTMLSelectElement).value), ($("enforce") as HTMLInputElement).checked);
  draw();
}

// The controls

const adds = $("adds");
for (const kind of KINDS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "add";
  button.dataset["add"] = kind.id;
  const amounts = [gbText(kind.memoryMb), cores(kind.cpu), ...(kind.browser ? ["browser"] : [])].join(" · ");
  button.innerHTML = `<span class="sw c${kind.color}" aria-hidden="true"></span><span class="add-text"><b>${escape(kind.label)}</b><span class="add-amounts">${escape(amounts)}</span></span>`;
  button.title = `${kind.job}: ${amounts}`;
  button.addEventListener("click", () => {
    sim.add(kind.id);
    draw();
  });
  adds.append(button);
}

const machineSelect = $("machine") as HTMLSelectElement;
for (const machine of MACHINES) machineSelect.add(new Option(machine.label, machine.id));
machineSelect.addEventListener("change", reset);
($("enforce") as HTMLInputElement).addEventListener("change", (event) => {
  sim.setEnforce((event.target as HTMLInputElement).checked);
  draw();
});

$("burst").addEventListener("click", () => {
  for (const [kind, holder] of BURST) sim.add(kind, holder);
  draw();
});
$("step").addEventListener("click", () => {
  sim.step(10);
  draw();
});
$("reset").addEventListener("click", reset);

for (const button of $("speeds").querySelectorAll<HTMLButtonElement>("button")) {
  button.addEventListener("click", () => setSpeed(Number(button.dataset["speed"])));
}

/** This function sets the speed of the clock: 0 stops it, 1 gives 2 simulated seconds each second, 4 gives 8. */
function setSpeed(next: number): void {
  for (const button of $("speeds").querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-pressed", String(Number(button.dataset["speed"]) === next));
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  if (next > 0) {
    timer = window.setInterval(() => {
      sim.step(1);
      draw();
    }, 500 / next);
  }
}

for (const id of ["queue", "running"]) {
  $(id).addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (button === null) return;
    const lease = button.dataset["lease"] ?? "";
    if (button.dataset["act"] === "cancel") sim.cancel(lease);
    else sim.stop(lease);
    draw();
  });
}

// The theme

const THEMES = ["auto", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const themeButton = $("theme");
function applyTheme(theme: Theme): void {
  if (theme === "auto") delete document.documentElement.dataset["theme"];
  else document.documentElement.dataset["theme"] = theme;
  themeButton.textContent = `Theme: ${theme}`;
  try {
    if (theme === "auto") localStorage.removeItem("headroom-theme");
    else localStorage.setItem("headroom-theme", theme);
  } catch {
    // A browser with no storage keeps the theme for this visit.
  }
}
const saved = document.documentElement.dataset["theme"];
applyTheme(saved === "light" || saved === "dark" ? saved : "auto");
themeButton.addEventListener("click", () => {
  const now = (document.documentElement.dataset["theme"] ?? "auto") as Theme;
  applyTheme(THEMES[(THEMES.indexOf(now) + 1) % THEMES.length] ?? "auto");
});

$("build").textContent = `Build ${__BUILD__.sha}, ${__BUILD__.date}`;

// The drawing

function draw(): void {
  const view = sim.view();
  $("clock").textContent = `Clock: ${Math.round(view.now)} s`;
  drawMachine(view);
  drawList("queue", view.waiting, "cancel");
  drawList("running", view.running, "stop");
  drawList("ended", view.ended.slice(0, 8), null);
  $("queue-count").textContent = String(view.waiting.length);
  $("running-count").textContent = String(view.running.length);
  $("ended-count").textContent = String(view.ended.length);
  $("timeline").innerHTML = timelineOf(view);
  $("log").innerHTML = view.events
    .slice(0, 8)
    .map((event) => `<li class="ev ${event.tone}"><span class="at">${Math.round(event.at)} s</span><span class="what"><b>${escape(event.job)}</b> ${escape(event.text)}</span></li>`)
    .join("");
}

function drawMachine(view: View): void {
  const { memory, machine } = view;
  const usedMb = view.running.reduce((sum, row) => sum + row.usedMb, 0);
  const heldMb = view.running.reduce((sum, row) => sum + Math.max(0, row.leaseMb - row.usedMb), 0);
  const freeMb = Math.max(0, view.free["memory"] ?? 0);
  const share = (mb: number): string => `${((Math.max(0, mb) / memory.totalMb) * 100).toFixed(2)}%`;
  const parts: string[] = [`<span class="part other" style="width:${share(memory.otherMb)}" title="Other programs: ${gbText(memory.otherMb)}"></span>`];
  for (const row of view.running) {
    const held = Math.max(0, row.leaseMb - row.usedMb);
    parts.push(`<span class="part job c${row.color}" style="width:${share(row.usedMb)}" title="${escape(row.job)} uses ${gbText(row.usedMb)}"></span>`);
    if (held > 0) parts.push(`<span class="part held c${row.color}" style="width:${share(held)}" title="${escape(row.job)}: ${gbText(held)} of its lease, not in use yet"></span>`);
  }
  parts.push(`<span class="part free" style="width:${share(freeMb)}" title="Free for a new lease: ${gbText(freeMb)}"></span>`);
  parts.push(`<span class="part reserve" style="width:${share(Math.min(memory.reserveMb, memory.availableMb))}" title="Kept free for the system: ${gbText(memory.reserveMb)}"></span>`);
  const membar = $("membar");
  membar.innerHTML = parts.join("");
  membar.setAttribute("aria-label", `Memory: ${gbText(memory.totalMb)} in all, ${gbText(usedMb)} in use by jobs, ${gbText(freeMb)} free for a new lease`);
  $("mem-text").textContent = `${gbText(memory.totalMb - memory.availableMb)} of ${gbText(memory.totalMb)} in use`;
  $("mem-legend").innerHTML = [
    ["other", "Other programs", memory.otherMb],
    ["job", "Jobs use", usedMb],
    ["held", "Leased, not in use yet", heldMb],
    ["free", "Free for a new lease", freeMb],
    ["reserve", "Kept for the system", memory.reserveMb],
  ]
    .map(([cls, label, mb]) => `<li><span class="k ${cls}"></span>${label} <b>${gbText(Number(mb))}</b></li>`)
    .join("");

  const cells: string[] = [];
  for (const row of view.running) for (let i = 0; i < row.cpu; i += 1) cells.push(`<span class="cell c${row.color}" title="${escape(row.job)}"></span>`);
  const kept = view.cpu.reserve;
  while (cells.length < machine.cores - kept) cells.push(`<span class="cell open" title="Free"></span>`);
  for (let i = 0; i < kept; i += 1) cells.push(`<span class="cell kept" title="Kept for you"></span>`);
  const cpu = $("cpu");
  cpu.innerHTML = cells.slice(0, machine.cores).join("");
  const leasedCores = view.running.reduce((sum, row) => sum + row.cpu, 0);
  cpu.setAttribute("aria-label", `Processors: ${leasedCores} of ${machine.cores} cores leased, ${kept} kept for you`);
  $("cpu-text").textContent = `${leasedCores} of ${machine.cores} leased · ${kept} kept for you`;

  const browsers = view.running.filter((row) => row.browser);
  const slots: string[] = browsers.map((row) => `<span class="cell slot c${row.color}" title="${escape(row.job)}">${escape(row.job)}</span>`);
  while (slots.length < machine.browsers) slots.push(`<span class="cell slot open">Free</span>`);
  const browser = $("browser");
  browser.innerHTML = slots.join("");
  browser.setAttribute("aria-label", `Browser slot: ${browsers.length} of ${machine.browsers} in use`);
  $("browser-text").textContent = `${browsers.length} of ${machine.browsers} in use`;

  const freeCpu = Math.max(0, view.free["cpu"] ?? 0);
  const freeBrowser = Math.max(0, view.free["browser"] ?? 0);
  $("free").innerHTML = `Free for a new lease: <b>${gbText(freeMb)}</b>, <b>${cores(freeCpu)}</b>, <b>${freeBrowser}</b> browser ${freeBrowser === 1 ? "slot" : "slots"}`;
}

/** This function updates a list of leases in place. Each lease keeps its element, so a click on its button is not lost. */
function drawList(id: string, rows: readonly Row[], act: "cancel" | "stop" | null): void {
  const list = $(id);
  const keep = new Map<string, HTMLElement>();
  for (const child of [...list.children] as HTMLElement[]) keep.set(child.dataset["id"] ?? "", child);
  rows.forEach((row, index) => {
    let item = keep.get(row.id);
    keep.delete(row.id);
    if (item === undefined) {
      item = document.createElement("li");
      item.dataset["id"] = row.id;
      item.innerHTML = `<span class="sw c${row.color}" aria-hidden="true"></span><div class="body"></div>`;
      if (act !== null) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "act";
        button.dataset["act"] = act;
        button.dataset["lease"] = row.id;
        button.textContent = act === "cancel" ? "Cancel" : "Stop";
        button.setAttribute("aria-label", `${act === "cancel" ? "Cancel" : "Stop"} ${row.job} of ${row.holder}`);
        item.append(button);
      }
    }
    item.className = `lease c${row.color} ${row.state}${row.outcome === null ? "" : ` ${row.outcome}`}`;
    const body = item.querySelector(".body");
    const html = bodyOf(row);
    if (body !== null && body.innerHTML !== html) body.innerHTML = html;
    if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
  });
  for (const item of keep.values()) item.remove();
  $(`${id}-empty`).hidden = rows.length > 0;
}

function bodyOf(row: Row): string {
  const tags = [row.heavy ? `<span class="tag heavy">spawn-heavy</span>` : "", row.browser ? `<span class="tag">browser</span>` : ""].join("");
  const amounts = `${gbText(row.leaseMb)} · ${cores(row.cpu)}`;
  const title = `<div class="title"><b class="job">${escape(row.job)}</b><span class="holder">${escape(row.holder)}</span>${tags}</div>`;
  if (row.state === "waiting") {
    return `${title}<div class="amounts">Asks for ${amounts}</div><p class="reason">${escape(row.reason ?? "waits")}</p>`;
  }
  if (row.state === "granted") {
    const over = row.usedMb > row.leaseMb;
    const use = Math.min(100, (row.usedMb / Math.max(1, row.leaseMb)) * 100);
    return `${title}<div class="amounts">Lease ${amounts}</div>
      <div class="meter${over ? " over" : ""}"><span class="meter-label">Memory</span><span class="track"><span class="fill c${row.color}" style="width:${use.toFixed(1)}%"></span></span><span class="meter-value">${gbText(row.usedMb)} of ${gbText(row.leaseMb)}</span></div>
      <div class="meter"><span class="meter-label">Run</span><span class="track"><span class="fill run" style="width:${(row.progress * 100).toFixed(1)}%"></span></span><span class="meter-value">${Math.round(row.progress * 100)}%</span></div>`;
  }
  const label = row.outcome === "done" ? "Done" : row.outcome === "stopped" ? "Stopped" : "Cancelled";
  const detail = row.outcome === "done" ? `peak ${gbText(row.peakMb)}` : (row.reason ?? "");
  return `${title}<p class="reason"><span class="outcome">${label}</span> ${escape(detail)}</p>`;
}

begin();
draw();
setSpeed(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1);
