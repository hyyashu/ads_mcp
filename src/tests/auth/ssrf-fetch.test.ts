import { type AddressInfo } from "node:net";
import { type IncomingMessage, type Server, type ServerResponse, createServer, request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { safeFetchBytes } from "../../auth/ssrf";

/** Points safeFetchBytes at a local plain-HTTP server, keeping every other check (status, type, size, deadline). */
let server: Server | undefined;
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<typeof httpRequest> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return ((_url: URL, opts: object, cb: (res: IncomingMessage) => void) => httpRequest({ ...opts, host: "127.0.0.1", port, path: "/", lookup: undefined }, cb)) as unknown as typeof httpRequest;
}
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  server = undefined;
});
const fetchIt = (transport: typeof httpRequest, timeoutMs = 2000) =>
  safeFetchBytes("https://images.example.com/a.png", { accept: "image/png", contentTypes: ["image/png"], maxBytes: 1024, timeoutMs, transport });

describe("safeFetchBytes always settles", () => {
  it("returns the body of a complete response", async () => {
    const t = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end("png-bytes");
    });
    await expect(fetchIt(t)).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("rejects when the server closes the connection after the headers (it used to stay pending forever)", async () => {
    const t = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "1000" });
      res.write("abc");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await expect(fetchIt(t)).rejects.toThrow(/closed before the document was complete|aborted|socket hang up/);
  });

  it("rejects a slow-drip server at the overall deadline, even though the socket is never idle", async () => {
    const t = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      const tick = setInterval(() => res.write("x"), 50);
      res.on("close", () => clearInterval(tick));
    });
    const started = Date.now();
    await expect(fetchIt(t, 400)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("rejects an oversized document instead of returning it truncated (one chunk or several)", async () => {
    const one = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(4096));
    });
    await expect(fetchIt(one)).rejects.toThrow(/too large/);
    server!.closeAllConnections();
    await new Promise((r) => server!.close(r));

    const many = await serve((_q, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.alloc(800));
      setTimeout(() => res.end(Buffer.alloc(800)), 20);
    });
    await expect(fetchIt(many)).rejects.toThrow(/too large/);
  });
});
