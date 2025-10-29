// piko - Express-compatible-ish lightweight framework (ESM single-file core)
// Author: IdiotStudios
import http from "http";
import url from "url";
import fs from "fs";
import path from "path";
import { StringDecoder } from "string_decoder";
import { fileURLToPath } from "url";

/** ---------- Utilities ---------- */

const isPromise = (v) => v && typeof v.then === "function";

function noop() {}

function ensureLeadingSlash(p) {
  if (!p) return "/";
  return p.startsWith("/") ? p : "/" + p;
}

/**
 * Turn a route like '/users/:id/*' into { regex, keys }
 * Very small path-to-regex implementation supporting:
 *  - named params :name
 *  - wildcard * (captures as param named '0' if used)
 */
function pathToRegexp(route) {
  if (route === "/") return { regex: /^\/?$/, keys: [] };
  const keys = [];
  // escape regex chars, except :param and *
  let s = route
    .replace(/([.+?^=!:${}()[\]|\\/])/g, "\\$1")
    .replace(/\*/g, "(.*)")
    .replace(/:(\w+)/g, (_, name) => {
      keys.push(name);
      return "([^/]+)";
    });
  // allow optional trailing slash, but keep start anchor
  const regex = new RegExp("^" + s.replace(/\/+$/, "") + "\\/?(?:$|\\/)", "i");
  return { regex, keys };
}

function parseUrl(req) {
  const parsed = url.parse(req.url || "", true);
  return {
    pathname: parsed.pathname || "/",
    query: parsed.query || {},
    path: parsed.path || req.url || "/",
  };
}

/** ---------- Response helpers (patch) ---------- */

function patchRes(res) {
  if (res._pikoPatched) return res;
  res._pikoPatched = true;

  res.status = function (code) {
    this.statusCode = code;
    return this;
  };

  res.set = res.setHeader; // alias
  res.get = res.getHeader;

  res.json = function (obj) {
    if (!this.headersSent) this.setHeader("Content-Type", "application/json; charset=utf-8");
    this.end(JSON.stringify(obj));
  };

  res.send = function (body) {
    if (body === undefined || body === null) {
      if (!this.headersSent) this.setHeader("Content-Type", "text/plain; charset=utf-8");
      return this.end("");
    }
    if (typeof body === "object" || Array.isArray(body)) return this.json(body);
    if (!this.headersSent) {
      // detect HTML simple heuristic
      if (String(body).trim().startsWith("<")) this.setHeader("Content-Type", "text/html; charset=utf-8");
      else this.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    this.end(String(body));
  };

  res.sendFile = function (filePath, opts = {}) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    fs.stat(abs, (err, st) => {
      if (err) {
        this.statusCode = 404;
        return this.end("Not found");
      }
      if (st.isDirectory()) {
        const index = path.join(abs, "index.html");
        return fs.stat(index, (e2) => {
          if (e2) {
            this.statusCode = 403;
            return this.end("Forbidden");
          }
          fs.createReadStream(index).pipe(this);
        });
      } else {
        const ext = path.extname(abs).toLowerCase();
        this.setHeader("Content-Type", mimeType(ext));
        fs.createReadStream(abs).pipe(this);
      }
    });
  };

  res.redirect = function (codeOrUrl, maybeUrl) {
    let code = 302;
    let urlLoc = codeOrUrl;
    if (typeof codeOrUrl === "number") {
      code = codeOrUrl;
      urlLoc = maybeUrl;
    }
    this.statusCode = code;
    this.setHeader("Location", urlLoc);
    this.end(`Redirecting to ${urlLoc}`);
  };

  return res;
}

/** ---------- Layer and Router handling ---------- */

function createLayer(route, fn, opts = {}) {
  // route: string or { router: Router, prefix } for mounted router
  if (opts.isRouter) {
    // router mount
    const prefix = ensureLeadingSlash(route || "/");
    const { regex, keys } = pathToRegexp(prefix);
    return { type: "router", prefix, regex, keys, router: fn };
  }
  const method = opts.method ? opts.method.toUpperCase() : null;
  const { regex, keys } = pathToRegexp(ensureLeadingSlash(route || "/"));
  return { type: "route", route: ensureLeadingSlash(route || "/"), regex, keys, fn, method };
}

/** ---------- App / Router factory ---------- */

function createApp() {
  const stack = []; // array of layers
  const params = new Map(); // key -> [fn, ...]

  function app(req, res, next) {
    // allow app to be used as handler: app(req,res)
    handle(req, res, next || noop);
  }

  app._stack = stack;

  function handle(inReq, inRes, outNext) {
    const req = inReq;
    const res = patchRes(inRes);
    const parsed = parseUrl(req);
    req.path = parsed.pathname;
    req.query = parsed.query;
    req.originalUrl = req.url;
    req.params = req.params || {};

    let idx = 0;
    let called = false;

    function invokeParamMiddleware(paramName, value, paramFns, paramIdx, cb) {
      if (!paramFns || paramIdx >= paramFns.length) return cb();
      const fn = paramFns[paramIdx];
      try {
        const maybe = fn(req, res, (err) => {
          if (err) return cb(err);
          invokeParamMiddleware(paramName, value, paramFns, paramIdx + 1, cb);
        }, value, paramName);
        if (isPromise(maybe)) {
          maybe.then(() => invokeParamMiddleware(paramName, value, paramFns, paramIdx + 1, cb)).catch(cb);
        }
      } catch (e) {
        cb(e);
      }
    }

    function runLayer(err) {
      if (called) return;
      const layer = stack[idx++];
      if (!layer) {
        if (err) return final(err, req, res, outNext);
        // no matching route -> 404
        res.statusCode = 404;
        return res.end(`Cannot ${req.method} ${req.url}`);
      }

      // router mount handling
      if (layer.type === "router") {
        const m = layer.regex.exec(req.path);
        if (!m) return runLayer(err);
        // strip prefix for nested router
        const oldUrl = req.url;
        const oldPath = req.path;
        const mountPath = layer.prefix === "/" ? "" : layer.prefix;
        // remove prefix from url/path for inner router
        req.url = req.url.replace(new RegExp("^" + mountPath), "") || "/";
        req.path = req.url.split("?")[0];
        // call router
        try {
          layer.router.handle(req, res, (e) => {
            // restore originals
            req.url = oldUrl;
            req.path = oldPath;
            runLayer(e);
          });
        } catch (e) {
          req.url = oldUrl;
          req.path = oldPath;
          runLayer(e);
        }
        return;
      }

      // route layer
      const match = layer.regex.exec(req.path);
      if (!match) return runLayer(err);

      // method check
      if (layer.method && layer.method !== req.method) return runLayer(err);

      // extract params
      const keys = layer.keys || [];
      for (let i = 0; i < keys.length; i++) {
        req.params[keys[i]] = match[i + 1] ? decodeURIComponent(match[i + 1]) : undefined;
      }

      // run any param middleware for newly set params
      const paramKeys = Object.keys(req.params);
      let pmIndex = 0;
      function runNextParam(cb) {
        if (pmIndex >= paramKeys.length) return cb();
        const pKey = paramKeys[pmIndex++];
        const fns = params.get(pKey);
        if (!fns || fns.length === 0) return runNextParam(cb);
        invokeParamMiddleware(pKey, req.params[pKey], fns, 0, (err2) => {
          if (err2) return cb(err2);
          runNextParam(cb);
        });
      }

      runNextParam((paramErr) => {
        if (paramErr) return runLayer(paramErr);

        // handler invocation
        try {
          if (err) {
            // find error middleware (fn length === 4)
            if (layer.fn.length === 4) {
              const maybe = layer.fn(err, req, res, (e) => runLayer(e));
              if (isPromise(maybe)) maybe.catch((e) => runLayer(e));
            } else {
              runLayer(err);
            }
          } else {
            if (layer.fn.length === 4) return runLayer();
            const maybe = layer.fn(req, res, (e) => runLayer(e));
            if (isPromise(maybe)) maybe.catch((e) => runLayer(e));
          }
        } catch (e) {
          runLayer(e);
        }
      });
    }

    runLayer();
  }

  app.handle = handle;

  /* ----- API methods ----- */

  app.use = function (routeOrFn, maybeFn) {
    if (typeof routeOrFn === "function") {
      const layer = createLayer("/", routeOrFn, {});
      stack.push(layer);
    } else if (typeof maybeFn === "function") {
      // mount function at path
      if (maybeFn._isRouter) {
        // mount router
        const layer = createLayer(routeOrFn, maybeFn, { isRouter: true });
        stack.push(layer);
      } else {
        const layer = createLayer(routeOrFn, maybeFn, {});
        stack.push(layer);
      }
    } else if (routeOrFn && routeOrFn._isRouter) {
      // app.use(router) or app.use('/prefix', router)
      const layer = createLayer("/", routeOrFn, { isRouter: true });
      stack.push(layer);
    }
    return app;
  };

  // HTTP verbs
  const methods = ["get", "post", "put", "patch", "delete", "options", "head"];
  methods.forEach((m) => {
    app[m] = function (route, fn) {
      if (typeof route === "function") {
        // app.get(fn) ? unlikely; ignore
        return app.use(route);
      }
      const layer = createLayer(route, fn, { method: m.toUpperCase() });
      stack.push(layer);
      return app;
    };
  });

  // router factory
  app.Router = function RouterFactory() {
    const router = createApp();
    router._isRouter = true;
    return router;
  };

  // app.param(name, fn)
  app.param = function (name, fn) {
    if (!params.has(name)) params.set(name, []);
    params.get(name).push(fn);
    return app;
  };

  app.listen = function (port, cb) {
    const server = http.createServer((req, res) => {
      // call the app as request handler
      handle(req, res, (err) => {
        if (err) {
          // fallback final
          final(err, req, res, noop);
        }
      });
    });
    return server.listen(port, cb);
  };

  // convenience for mounting whole router: app.mount('/prefix', router)
  app.mount = function (prefix, router) {
    app.use(prefix, router);
    return app;
  };

  return app;
}

/** ---------- Final error handler ---------- */

function final(err, req, res, next) {
  if (res.headersSent) return;
  const status = (err && err.status) || 500;
  res.statusCode = status;
  const accept = (req.headers && req.headers.accept) || "";
  if (accept.includes("application/json")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: err && err.message ? err.message : String(err) }));
  } else {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(String(err && err.message ? err.message : "Internal Server Error"));
  }
}

/** ---------- Built-in middleware factories ---------- */

function json(opts = {}) {
  const limit = parseSize(opts.limit || "1mb");
  return (req, res, next) => {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("application/json")) return next();
    let raw = "";
    const decoder = new StringDecoder("utf8");
    let length = Number(req.headers["content-length"] || 0);
    req.on("data", (chunk) => {
      raw += decoder.write(chunk);
      if (limit && raw.length > limit) {
        const err = new Error("Payload too large");
        err.status = 413;
        req.destroy();
      }
    });
    req.on("end", () => {
      raw += decoder.end();
      if (!raw) {
        req.body = {};
        return next();
      }
      try {
        req.body = JSON.parse(raw);
        next();
      } catch (e) {
        e.status = 400;
        next(e);
      }
    });
  };
}

function urlencoded(opts = {}) {
  const limit = parseSize(opts.limit || "1mb");
  return (req, res, next) => {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("application/x-www-form-urlencoded")) return next();
    let raw = "";
    const decoder = new StringDecoder("utf8");
    req.on("data", (chunk) => {
      raw += decoder.write(chunk);
      if (limit && raw.length > limit) req.destroy();
    });
    req.on("end", () => {
      raw += decoder.end();
      req.body = Object.fromEntries(new URLSearchParams(raw));
      next();
    });
  };
}

function raw(opts = {}) {
  const limit = parseSize(opts.limit || "1mb");
  return (req, res, next) => {
    let chunks = [];
    let size = 0;
    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (limit && size > limit) req.destroy();
    });
    req.on("end", () => {
      req.body = Buffer.concat(chunks);
      next();
    });
  };
}

function text(opts = {}) {
  const limit = parseSize(opts.limit || "1mb");
  return (req, res, next) => {
    let s = "";
    const decoder = new StringDecoder("utf8");
    req.on("data", (c) => {
      s += decoder.write(c);
      if (limit && s.length > limit) req.destroy();
    });
    req.on("end", () => {
      s += decoder.end();
      req.body = s;
      next();
    });
  };
}

/** ---------- Static files middleware (with simple caching + headers) ---------- */

function staticServe(root, opts = {}) {
  const absRoot = path.resolve(root || process.cwd());
  const maxAge = opts.maxAge || 0;

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const parsed = parseUrl(req);
    let reqPath = decodeURIComponent(parsed.pathname || "/");
    // allow mount like app.use('/static', piko.static('public')), so reqPath may include prefix
    // compute physical path relative to root (strip leading slash)
    const rel = reqPath.replace(/^\/+/, "");
    const full = path.join(absRoot, rel);

    if (!full.startsWith(absRoot)) {
      res.statusCode = 403;
      return res.end("Forbidden");
    }

    fs.stat(full, (err, st) => {
      if (err) return next();
      if (st.isDirectory()) {
        const idx = path.join(full, "index.html");
        return fs.stat(idx, (e2, s2) => {
          if (e2) return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          if (maxAge) res.setHeader("Cache-Control", `public, max-age=${Math.floor(maxAge / 1000)}`);
          fs.createReadStream(idx).pipe(res);
        });
      } else {
        res.setHeader("Content-Type", mimeType(path.extname(full)));
        if (maxAge) res.setHeader("Cache-Control", `public, max-age=${Math.floor(maxAge / 1000)}`);
        fs.createReadStream(full).pipe(res);
      }
    });
  };
}

/** ---------- Helpers ---------- */

function parseSize(s) {
  if (typeof s === "number") return s;
  const m = String(s).toLowerCase().match(/^(\d+)(b|kb|mb|gb)?$/);
  if (!m) return undefined;
  const v = Number(m[1]);
  const u = m[2] || "b";
  switch (u) {
    case "kb":
      return v * 1024;
    case "mb":
      return v * 1024 * 1024;
    case "gb":
      return v * 1024 * 1024 * 1024;
    default:
      return v;
  }
}

function mimeType(ext) {
  const map = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
    "": "application/octet-stream",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
}

/** ---------- Export default (piko) ---------- */

function pikoFactory() {
  const app = createApp();
  // attach built-ins
  app.json = json;
  app.urlencoded = urlencoded;
  app.raw = raw;
  app.text = text;
  app.static = staticServe;
  app.finalHandler = final;
  // convenience: create Router
  app.Router = () => {
    const r = createApp();
    r._isRouter = true;
    return r;
  };
  // convenience to use as default exported factory: piko()
  return function piko() {
    return app;
  };
}

const core = createApp();

// Attach built-ins to core (so piko.json() etc. callable)
core.json = json;
core.urlencoded = urlencoded;
core.raw = raw;
core.text = text;
core.static = staticServe;
core.Router = function () {
  const r = createApp();
  r._isRouter = true;
  return r;
};
core.finalHandler = final;

// Default export is a function that returns a new app with those helpers
function piko() {
  return createApp();
}

// Attach helpers onto the exported function for convenience
piko.json = json;
piko.urlencoded = urlencoded;
piko.raw = raw;
piko.text = text;
piko.static = staticServe;
piko.Router = core.Router;
piko.finalHandler = final;

export default piko;
