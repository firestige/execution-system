#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
  const [assetsValue, readyValue] = process.argv.slice(2);
  if (assetsValue === undefined || readyValue === undefined) throw new Error("usage: serve-workflow-assets ASSETS READY_FILE");
  const assets = path.resolve(assetsValue);
  const readyFile = path.resolve(readyValue);
  const certificate = `${readyFile}.crt`;
  const key = `${readyFile}.key`;
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", key, "-out", certificate,
  ], { stdio: "ignore" });
  const metadata = JSON.parse(await readFile(path.join(assets, "release-metadata.json"), "utf8")) as any;
  let origin = "";
  const server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/releases") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(metadata.packages.map((item: any) => ({
        tag_name: item.tag, draft: false, prerelease: false,
        assets: item.assets.map(({ name }: any) => ({ name, browser_download_url: `${origin}/assets/${encodeURIComponent(name)}` })),
      }))));
      return;
    }
    const match = /^\/assets\/([^/]+)$/u.exec(url.pathname);
    const name = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    if (name === undefined || path.basename(name) !== name) { response.writeHead(404).end(); return; }
    void readFile(path.join(assets, name)).then(
      (bytes) => { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(bytes); },
      () => { response.writeHead(404).end(); },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("WORKFLOW_ASSET_SERVER_UNAVAILABLE");
  origin = `https://localhost:${String(address.port)}`;
  await writeFile(readyFile, `${JSON.stringify({ releasesBaseUrl: `${origin}/releases`, certificate })}\n`, { mode: 0o600 });
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
