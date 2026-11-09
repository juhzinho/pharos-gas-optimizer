import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PACIFIC_RPC } from "./contracts.js";

/** The Anvil binary: ANVIL_BIN, the platform package installed by npm, or `anvil` on PATH. */
export function anvilBin() {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const pkg = `@foundry-rs/anvil-${process.platform === "win32" ? "win32" : process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    const file = join(dirname(require.resolve(`${pkg}/package.json`)), "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
    if (existsSync(file)) return file;
  } catch {}
  return "anvil";
}

async function rpcUp(url) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }) });
    const body = await res.json();
    return /anvil/i.test(body.result ?? "");
  } catch {
    return false;
  }
}

/**
 * Starts an Anvil fork of Pharos Pacific Mainnet at the latest block (or `block`).
 * Anvil (not Hardhat) because Pharos headers have no excessBlobGas and the Morpho vaults need Cancun opcodes.
 */
export async function startFork({ port = 8545, block, rpc = PACIFIC_RPC, quiet = true, detached = false } = {}) {
  const url = `http://127.0.0.1:${port}`;
  if (await rpcUp(url)) return { url, reused: true, stop: () => {} };
  const args = ["--fork-url", rpc, "--chain-id", "1672", "--port", String(port), "--host", "127.0.0.1", "--silent"];
  if (block) args.push("--fork-block-number", String(block));
  // detached: the fork outlives this process, so a crashed saga can be resumed against the same chain state.
  const child = spawn(anvilBin(), args, { stdio: quiet || detached ? "ignore" : "inherit", detached, windowsHide: true });
  if (detached) child.unref();
  let failed = null;
  child.on("error", (e) => (failed = e));
  for (let i = 0; i < 120; i++) {
    if (failed) throw new Error(`could not start Anvil (${failed.message}). Install Foundry or run npm install.`);
    if (await rpcUp(url)) return { url, reused: false, child, stop: () => child.kill() };
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("Anvil did not answer within 60 s");
}

