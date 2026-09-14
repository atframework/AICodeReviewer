/**
 * Build asset copy (P6): the dashboard HTML shell and the plain-JS client
 * modules live under src/dashboard but are served from dist/dashboard. Core
 * paradigm modules (config-ui-runtime, config-form-state, weekly-schedule)
 * are compiled by @aicr/core and served verbatim to the browser, so they are
 * copied from the core dist output. Missing assets fail the build so a
 * successful package build always contains a usable management UI.
 */
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.join(__dirname, "..");
const distDashboard = path.join(packageRoot, "dist", "dashboard");
const distClient = path.join(distDashboard, "client");

fs.mkdirSync(distClient, { recursive: true });

fs.copyFileSync(
  path.join(packageRoot, "src", "dashboard", "dashboard.html"),
  path.join(distDashboard, "dashboard.html"),
);

const srcClient = path.join(packageRoot, "src", "dashboard", "client");
if (fs.existsSync(srcClient)) {
  for (const entry of fs.readdirSync(srcClient)) {
    if (entry.endsWith(".js")) {
      fs.copyFileSync(path.join(srcClient, entry), path.join(distClient, entry));
    }
  }
}

const coreDist = path.dirname(require.resolve("@aicr/core"));
for (const name of ["config-ui-runtime.js", "config-form-state.js", "weekly-schedule.js"]) {
  const from = path.join(coreDist, name);
  fs.copyFileSync(from, path.join(distClient, name));
}
