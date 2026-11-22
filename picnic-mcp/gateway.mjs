// Picnic MCP gateway for Home Assistant
//
// Runs mcp-picnic on 127.0.0.1 and exposes a small authenticated gateway on :8099.
//  - Auth: "Authorization: Bearer <token>", "x-api-key: <token>", or the token as
//    first path segment: /<token>/mcp (for clients that cannot send headers).
//  - Blocked tools are hidden from tools/list and refused on tools/call.
//  - Only /mcp and /health are reachable from outside.

import { spawn } from "node:child_process"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import http from "node:http"

const OPTIONS_FILE = process.env.OPTIONS_FILE || "/data/options.json"
const DATA_DIR = process.env.DATA_DIR || "/data"
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8099)
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 3000)
const UPSTREAM_BIN = process.env.UPSTREAM_BIN || "/app/node_modules/mcp-picnic/bin/mcp-server.js"
const SKIP_SPAWN = process.env.SKIP_SPAWN === "1"
const MAX_BODY = 1024 * 1024

const log = (...a) => console.log(new Date().toISOString(), "[gateway]", ...a)

let opts
try {
  opts = JSON.parse(readFileSync(OPTIONS_FILE, "utf8"))
} catch (e) {
  log("Kan opties niet lezen:", e.message)
  process.exit(1)
}

// Token: from options, or generated once and kept in /data/auth_token.
let token = String(opts.auth_token || "").trim()
if (!token) {
  const tokenFile = `${DATA_DIR}/auth_token`
  try {
    token = readFileSync(tokenFile, "utf8").trim()
  } catch {
    token = randomBytes(24).toString("base64url")
    writeFileSync(tokenFile, token + "\n", { mode: 0o600 })
  }
  log("Geen auth_token ingesteld; automatisch gegenereerd token wordt gebruikt.")
  log(`Connector-pad: /${token}/mcp   (header-variant: Authorization: Bearer ${token})`)
}
if (token.length < 20 || !/^[A-Za-z0-9_-]+$/.test(token)) {
  log("auth_token is te zwak. Gebruik minimaal 20 tekens (letters, cijfers, - of _), of laat het leeg.")
  process.exit(1)
}
if (!opts.picnic_username || !opts.picnic_password) {
  log("picnic_username en picnic_password zijn verplicht.")
  process.exit(1)
}

const blocked = new Set((opts.blocked_tools || []).map((s) => String(s).trim()).filter(Boolean))
const innerToken = process.env.INNER_TOKEN || randomBytes(32).toString("hex")

// ---------- upstream process ----------
function startUpstream() {
  if (SKIP_SPAWN) return
  const child = spawn(process.execPath, [UPSTREAM_BIN], {
    env: {
      ...process.env,
      PICNIC_USERNAME: opts.picnic_username,
      PICNIC_PASSWORD: opts.picnic_password,
      PICNIC_COUNTRY_CODE: opts.country_code || "NL",
      PICNIC_SESSION_FILE: `${DATA_DIR}/picnic-session.json`,
      PICNIC_DEVICE_FILE: `${DATA_DIR}/picnic-device.json`,
      ENABLE_HTTP_SERVER: "true",
      HTTP_HOST: "127.0.0.1",
      HTTP_PORT: String(UPSTREAM_PORT),
      HTTP_AUTH_TOKEN: innerToken,
      HTTP_TRUST_PROXY: "loopback",
      HTTP_RATE_LIMIT_MAX_REQUESTS: "600",
    },
    stdio: ["ignore", "inherit", "inherit"],
  })
  child.on("exit", (code, signal) => {
    log(`mcp-picnic gestopt (code=${code}, signal=${signal}); herstart over 5s`)
    setTimeout(startUpstream, 5000)
  })
}

// ---------- helpers ----------
function tokenOk(candidate) {
  if (typeof candidate !== "string") return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function authorize(req) {
  const url = new URL(req.url, "http://x")
  const m = url.pathname.match(/^\/([^/]+)\/mcp\/?$/)
  if (m && tokenOk(decodeURIComponent(m[1]))) return "/mcp" + url.search
  if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
    const auth = req.headers["authorization"]
    if (typeof auth === "string" && auth.startsWith("Bearer ") && tokenOk(auth.slice(7).trim())) {
      return "/mcp" + url.search
    }
    if (tokenOk(req.headers["x-api-key"])) return "/mcp" + url.search
  }
  return null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error("too_large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

function filterToolsInMessage(msg) {
  if (msg && msg.result && Array.isArray(msg.result.tools)) {
    msg.result.tools = msg.result.tools.filter((t) => !blocked.has(t.name))
  }
  return msg
}

function filterPayload(text, contentType) {
  if (contentType.includes("text/event-stream")) {
    return text
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) return line
        const raw = line.slice(5).trim()
        try {
          const parsed = JSON.parse(raw)
          const out = Array.isArray(parsed) ? parsed.map(filterToolsInMessage) : filterToolsInMessage(parsed)
          return "data: " + JSON.stringify(out)
        } catch {
          return line
        }
      })
      .join("\n")
  }
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(text)
      const out = Array.isArray(parsed) ? parsed.map(filterToolsInMessage) : filterToolsInMessage(parsed)
      return JSON.stringify(out)
    } catch {
      return text
    }
  }
  return text
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname
    if (path === "/health") return sendJson(res, 200, { ok: true })

    const target = authorize(req)
    if (!target) return sendJson(res, 401, { error: "unauthorized" })

    let body = null
    let wantsToolList = false
    if (req.method === "POST") {
      try {
        body = await readBody(req)
      } catch {
        return sendJson(res, 413, { error: "body_too_large" })
      }
      let parsed = null
      try {
        parsed = JSON.parse(body.toString("utf8"))
      } catch {
        /* let upstream answer */
      }
      const msgs = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
      const blockedCalls = msgs.filter(
        (m) => m && m.method === "tools/call" && m.params && blocked.has(m.params.name),
      )
      if (blockedCalls.length) {
        log(`Geblokkeerde tool geweigerd: ${blockedCalls.map((m) => m.params.name).join(", ")}`)
        const replies = blockedCalls.map((m) => ({
          jsonrpc: "2.0",
          id: m.id ?? null,
          result: {
            content: [
              {
                type: "text",
                text: `De tool '${m.params.name}' is uitgeschakeld in de Picnic MCP add-on. Doe dit zelf in de Picnic-app.`,
              },
            ],
            isError: true,
          },
        }))
        return sendJson(res, 200, Array.isArray(parsed) ? replies : replies[0])
      }
      wantsToolList = msgs.some((m) => m && m.method === "tools/list")
    }

    const headers = { ...req.headers }
    delete headers["authorization"]
    delete headers["x-api-key"]
    delete headers["content-length"]
    delete headers["host"]
    headers["host"] = `127.0.0.1:${UPSTREAM_PORT}`
    headers["authorization"] = `Bearer ${innerToken}`
    if (body) headers["content-length"] = String(body.length)

    const upstreamReq = http.request(
      { host: "127.0.0.1", port: UPSTREAM_PORT, method: req.method, path: target, headers },
      (up) => {
        const outHeaders = { ...up.headers }
        if (!wantsToolList) {
          res.writeHead(up.statusCode || 502, outHeaders)
          up.pipe(res)
          return
        }
        const chunks = []
        up.on("data", (c) => chunks.push(c))
        up.on("end", () => {
          const ct = String(up.headers["content-type"] || "")
          const filtered = Buffer.from(filterPayload(Buffer.concat(chunks).toString("utf8"), ct))
          delete outHeaders["content-length"]
          delete outHeaders["transfer-encoding"]
          outHeaders["content-length"] = String(filtered.length)
          res.writeHead(up.statusCode || 502, outHeaders)
          res.end(filtered)
        })
      },
    )
    upstreamReq.on("error", (e) => {
      log("Upstream fout:", e.message)
      if (!res.headersSent) sendJson(res, 502, { error: "upstream_unavailable" })
      else res.end()
    })
    res.on("close", () => {
      if (!res.writableEnded) upstreamReq.destroy()
    })
    if (body) upstreamReq.end(body)
    else upstreamReq.end()
  } catch (e) {
    log("Fout:", e.message)
    if (!res.headersSent) sendJson(res, 500, { error: "internal" })
  }
})

server.requestTimeout = 0
server.headersTimeout = 60_000
server.listen(LISTEN_PORT, "0.0.0.0", () => {
  log(`Gateway luistert op :${LISTEN_PORT}; ${blocked.size} tools geblokkeerd`)
  startUpstream()
})
