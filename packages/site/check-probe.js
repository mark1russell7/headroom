// The probe of the lease simulator. The site check of the Pages workflow runs it in a browser, at each width,
// before the deploy (site-check-probe in .github/workflows/pages.yml). A failed check stops the deploy.
// The helpers check, wait, until, $, $$, type and click come from the site check (the README of site-pages).

const rows = (list) => $$(`#${list} .lease`);
const jobs = (list) => rows(list).map((li) => li.querySelector(".job")?.textContent ?? "");

check("the page starts with jobs in the simulator", await until(() => rows("running").length > 0 && rows("queue").length > 0), `${rows("running").length} running, ${rows("queue").length} waiting`);
check("the timeline shows a lane for each lease", $$("#timeline .lane:not(.axis)").length >= 4, `${$$("#timeline .lane").length} lanes`);

// The clock stops, so each step of the probe gives the same state.
click('[data-speed="0"]');
click("#reset");
check("Reset empties the computer", await until(() => rows("running").length === 0 && rows("queue").length === 0), jobs("running").join(", "));

click('[data-add="leak"]');
click("#step");
check("the job with a leak stops at its memory limit", await until(() => $$("#ended .lease.stopped").length > 0), jobs("ended").join(", "));

click('[data-add="e2e"]');
check("a browser test gets its lease at once", await until(() => jobs("running").includes("pnpm e2e")), jobs("running").join(", "));

click('[data-add="churn"]');
const spawnWait = () => $$("#queue .lease .reason").map((p) => p.textContent ?? "").find((text) => text.includes("browsers can fail to start beside it"));
check("a spawn-heavy job waits for the browser test, with the reason of the broker", await until(spawnWait), $$("#queue .lease .reason").map((p) => p.textContent).join(" | "));

click("#burst");
check("the burst puts more jobs in the queue", await until(() => rows("queue").length >= 3), `${rows("queue").length} waiting`);
check("each waiting job tells why it waits", rows("queue").every((li) => /^waits /.test(li.querySelector(".reason")?.textContent ?? "")), $$("#queue .reason").map((p) => p.textContent).join(" | "));
check("the queue count shows the waiting jobs", $("#queue-count")?.textContent === String(rows("queue").length), $("#queue-count")?.textContent);

for (let i = 0; i < 6; i += 1) click("#step");
check("a waiting job starts when a running job ends", await until(() => $$("#ended .lease.done").length > 0 && rows("running").length > 0), `${jobs("ended").join(", ")} / ${jobs("running").join(", ")}`);
check("the broker log names the decisions", $$("#log .ev").length > 0, `${$$("#log .ev").length} events`);
