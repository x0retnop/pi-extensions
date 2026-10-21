// curl.exe transport — Cloudflare JA3/JA4 blocks Node undici/https on
// mcp.exa.ai and many fetch targets; curl.exe passes. Body goes to a temp
// file; `-w %{http_code}` is the only reliable status (header-file
// parseInt("HTTP/1.1 200") is 0).
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CurlResponse {
  status: number;
  body: string;
  headers: string;
}

export interface CurlOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  body?: string;
  /** Extra curl args inserted before the URL (`-H`, `-A`, `-L`, ...). */
  extraArgs?: string[];
}

export function parseCurlHttpCode(writeOut: string): number {
  return Number.parseInt(String(writeOut).trim(), 10) || 0;
}

export function headerValue(headers: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(\\S+)`, "im");
  const m = headers.match(re);
  return m ? m[1].trim() : "";
}

/** Last Content-Type across redirect hops in a `-D` dump. */
export function lastContentType(headers: string): string {
  const matches = [...headers.matchAll(/^content-type:\s*([^\r\n]+)/gim)];
  return (matches.at(-1)?.[1] ?? "").trim();
}

export function runCurl(url: string, opts: CurlOptions): Promise<CurlResponse> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    const tmp = mkdtempSync(join(tmpdir(), "wsst-"));
    const outFile = join(tmp, "out");
    const hdrFile = join(tmp, "hdr");
    const cmd = [
      "-s", "-o", outFile, "-w", "%{http_code}", "-D", hdrFile,
      "--max-time", String(Math.max(1, Math.ceil(opts.timeoutMs / 1000))),
      ...(opts.extraArgs ?? []),
      ...(opts.body !== undefined ? ["-d", opts.body] : []),
      url,
    ];
    const cleanup = () => {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    const child = execFile(
      "curl.exe",
      cmd,
      { windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        opts.signal?.removeEventListener("abort", onAbort);
        let body = "";
        let headers = "";
        try { body = readFileSync(outFile, "utf-8"); } catch { /* curl wrote nothing */ }
        try { headers = readFileSync(hdrFile, "utf-8"); } catch { /* curl wrote nothing */ }
        cleanup();
        if (opts.signal?.aborted) {
          reject(abortError());
          return;
        }
        if (err && !body) {
          reject(new Error(`curl failed: ${err.message}`));
          return;
        }
        resolve({ status: parseCurlHttpCode(stdout), body, headers });
      },
    );
    const onAbort = () => {
      try { child.kill(); } catch { /* already exited */ }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
