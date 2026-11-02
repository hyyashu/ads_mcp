const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Every dynamic value that reaches HTML goes through this. Ad-platform text is untrusted. */
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);

export const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY", // consent and approval pages must never be framed (clickjacking)
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

const CSS = `body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#16202a}
h1{font-size:20px}h2{font-size:16px;margin-top:28px}.card{border:1px solid #d6dde4;border-radius:8px;padding:14px 16px;margin:12px 0}
button{font:inherit;padding:7px 14px;border-radius:6px;border:1px solid #9aa7b4;background:#fff;cursor:pointer}
button.primary{background:#1f4fd8;color:#fff;border-color:#1f4fd8}button.danger{color:#b3261e;border-color:#b3261e}
input{font:inherit;padding:7px 9px;border:1px solid #9aa7b4;border-radius:6px;width:100%;box-sizing:border-box;margin:4px 0 12px}
.muted{color:#5b6b79;font-size:13px}.msg{background:#eef4ff;border:1px solid #c5d6fb;padding:8px 12px;border-radius:6px}
.err{background:#fdecea;border:1px solid #f3b8b3;padding:8px 12px;border-radius:6px}code{background:#f0f3f6;padding:1px 5px;border-radius:4px}
form{display:inline}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}`;

export const page = (title: string, body: string, nav = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${nav}<h1>${esc(title)}</h1>${body}</body></html>`;

export const flash = (msg: string | null, isError = false) => (msg ? `<p class="${isError ? "err" : "msg"}">${esc(msg)}</p>` : "");
export const hidden = (name: string, value: string) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
