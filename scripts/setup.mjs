#!/usr/bin/env node
/**
 * First-time production setup: D1 + R2, migrations, SR_TOKEN secret, deploy.
 * Email (Resend) is configured later in Settings — not required here.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerPath = join(root, "wrangler.jsonc");
const D1_NAME = "sr";
const R2_NAME = "sr-assets";

const rl = createInterface({ input, output });

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    ...opts
  });
  return r;
}

function wrangler(args, opts = {}) {
  return run("npx", ["wrangler", ...args], opts);
}

function stripJsonc(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function readConfig() {
  return JSON.parse(stripJsonc(readFileSync(wranglerPath, "utf8")));
}

function setDatabaseId(id) {
  const raw = readFileSync(wranglerPath, "utf8");
  if (!/"database_id"\s*:/.test(raw)) {
    throw new Error("wrangler.jsonc: missing database_id field");
  }
  writeFileSync(wranglerPath, raw.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`));
}

async function ask(prompt, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || fallback;
}

async function confirm(prompt, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${prompt} (${hint}): `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function ensureLoggedIn() {
  const who = wrangler(["whoami"]);
  if (who.status !== 0) {
    console.log("Not logged in to Cloudflare. Opening login…");
    const login = wrangler(["login"], { stdio: "inherit" });
    if (login.status !== 0) {
      console.error("wrangler login failed.");
      process.exit(1);
    }
  } else {
    console.log(who.stdout.trim().split("\n")[0] || "Logged in to Cloudflare.");
  }
}

function listD1() {
  const r = wrangler(["d1", "list", "--json"]);
  if (r.status !== 0) return [];
  try {
    const data = JSON.parse(r.stdout);
    return Array.isArray(data) ? data : (data?.result ?? data?.databases ?? []);
  } catch {
    return [];
  }
}

function ensureD1() {
  const existing = listD1().find(d => d.name === D1_NAME || d.database_name === D1_NAME);
  if (existing?.uuid || existing?.id) {
    const id = existing.uuid || existing.id;
    console.log(`D1 database "${D1_NAME}" already exists (${id}).`);
    setDatabaseId(id);
    return id;
  }
  console.log(`Creating D1 database "${D1_NAME}"…`);
  const created = wrangler(["d1", "create", D1_NAME]);
  const out = `${created.stdout}\n${created.stderr}`;
  if (created.status !== 0 && !/already exists/i.test(out)) {
    console.error(out);
    process.exit(1);
  }
  const match = out.match(/database_id\s*=\s*"?([0-9a-f-]{36})"?/i)
    || out.match(/"uuid"\s*:\s*"([0-9a-f-]{36})"/i)
    || out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!match) {
    const again = listD1().find(d => d.name === D1_NAME || d.database_name === D1_NAME);
    if (again?.uuid || again?.id) {
      const id = again.uuid || again.id;
      setDatabaseId(id);
      return id;
    }
    console.error("Could not parse database_id from wrangler output:\n", out);
    process.exit(1);
  }
  setDatabaseId(match[1]);
  console.log(`Wrote database_id ${match[1]} into wrangler.jsonc.`);
  return match[1];
}

function ensureR2() {
  console.log(`Ensuring R2 bucket "${R2_NAME}"…`);
  const created = wrangler(["r2", "bucket", "create", R2_NAME]);
  const out = `${created.stdout}\n${created.stderr}`;
  if (created.status === 0) {
    console.log(`Created R2 bucket "${R2_NAME}".`);
    return;
  }
  if (/already exists|10004|bucket.*exist/i.test(out)) {
    console.log(`R2 bucket "${R2_NAME}" already exists.`);
    return;
  }
  if (/10042|Please enable R2/i.test(out)) {
    console.error("R2 is not enabled on this account. Enable it in the Cloudflare dashboard (R2 → Overview), then re-run npm run setup.");
    process.exit(1);
  }
  console.error(out);
  process.exit(1);
}

function migrateRemote() {
  console.log("Applying D1 migrations (remote)…");
  const r = wrangler(["d1", "migrations", "apply", "DB", "--remote"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function putSecret(name, value) {
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], {
    cwd: root,
    encoding: "utf8",
    input: value + "\n",
    stdio: ["pipe", "inherit", "inherit"]
  });
  if (r.status !== 0) {
    console.error(`Failed to set secret ${name}`);
    process.exit(r.status ?? 1);
  }
}

function deploy() {
  console.log("Deploying worker…");
  // Use wrangler deploy only — package.json `deploy` also migrates, which we already did.
  const r = wrangler(["deploy"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function workerUrlFromConfig() {
  const name = readConfig().name || "spaced-repetition";
  return `https://${name}.workers.dev`;
}

async function main() {
  console.log("spaced-repetition — first-time production setup\n");
  ensureLoggedIn();
  ensureD1();
  ensureR2();
  migrateRemote();

  const generated = randomBytes(32).toString("hex");
  const token = await ask("SR_TOKEN (auth secret)", generated);
  putSecret("SR_TOKEN", token);

  if (await confirm("Deploy now?", true)) {
    deploy();
  } else {
    console.log("Skipped deploy. Run `npm run deploy` when ready.");
  }

  const base = workerUrlFromConfig();
  console.log(`
Done.

Open once to set the cookie:
  ${base}/?token=${token}

Then (optional) enable reminder email in Settings → Reminder:
  paste your Resend API key and destination address.
  EMAIL_FROM defaults to "Resurface <onboarding@resend.dev>" (Resend test sender).
  For production, verify a domain in Resend and:
    npx wrangler secret put EMAIL_FROM

Health check:
  curl ${base}/health
`);
  rl.close();
}

main().catch(err => {
  console.error(err);
  rl.close();
  process.exit(1);
});
