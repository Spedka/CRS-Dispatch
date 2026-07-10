var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/hono/dist/compose.js
var compose = /* @__PURE__ */ __name((middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || void 0;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
    __name(dispatch, "dispatch");
  };
}, "compose");

// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/body.js
var parseBody = /* @__PURE__ */ __name(async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = request instanceof HonoRequest ? request.raw.headers : request.headers;
  const contentType = headers.get("Content-Type");
  if (contentType?.startsWith("multipart/form-data") || contentType?.startsWith("application/x-www-form-urlencoded")) {
    return parseFormData(request, { all, dot });
  }
  return {};
}, "parseBody");
async function parseFormData(request, options) {
  const formData = await request.formData();
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
__name(parseFormData, "parseFormData");
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
__name(convertFormDataToBodyData, "convertFormDataToBodyData");
var handleParsingAllValues = /* @__PURE__ */ __name((form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) {
      ;
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
}, "handleParsingAllValues");
var handleParsingNestedValues = /* @__PURE__ */ __name((form, key, value) => {
  if (/(?:^|\.)__proto__\./.test(key)) {
    return;
  }
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
}, "handleParsingNestedValues");

// node_modules/hono/dist/utils/url.js
var splitPath = /* @__PURE__ */ __name((path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
}, "splitPath");
var splitRoutingPath = /* @__PURE__ */ __name((routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
}, "splitRoutingPath");
var extractGroupsFromPath = /* @__PURE__ */ __name((path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return { groups, path };
}, "extractGroupsFromPath");
var replaceGroupMarks = /* @__PURE__ */ __name((paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
}, "replaceGroupMarks");
var patternCache = {};
var getPattern = /* @__PURE__ */ __name((label, next) => {
  if (label === "*") {
    return "*";
  }
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match2[1], new RegExp(`^${match2[2]}(?=/${next})`)] : [label, match2[1], new RegExp(`^${match2[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match2[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
}, "getPattern");
var tryDecode = /* @__PURE__ */ __name((str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
}, "tryDecode");
var tryDecodeURI = /* @__PURE__ */ __name((str) => tryDecode(str, decodeURI), "tryDecodeURI");
var getPath = /* @__PURE__ */ __name((request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
}, "getPath");
var getPathNoStrict = /* @__PURE__ */ __name((request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
}, "getPathNoStrict");
var mergePath = /* @__PURE__ */ __name((base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
}, "mergePath");
var checkOptionalParameter = /* @__PURE__ */ __name((path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
}, "checkOptionalParameter");
var _decodeURI = /* @__PURE__ */ __name((value) => {
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return value.indexOf("%") !== -1 ? tryDecode(value, decodeURIComponent_) : value;
}, "_decodeURI");
var _getQueryParam = /* @__PURE__ */ __name((url, key, multiple) => {
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return void 0;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return void 0;
    }
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(
      keyIndex + 1,
      valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex
    );
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      ;
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
}, "_getQueryParam");
var getQueryParam = _getQueryParam;
var getQueryParams = /* @__PURE__ */ __name((url, key) => {
  return _getQueryParam(url, key, true);
}, "getQueryParams");
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var tryDecodeURIComponent = /* @__PURE__ */ __name((str) => tryDecode(str, decodeURIComponent_), "tryDecodeURIComponent");
var HonoRequest = class {
  static {
    __name(this, "HonoRequest");
  }
  /**
   * `.raw` can get the raw Request object.
   *
   * @see {@link https://hono.dev/docs/api/request#raw}
   *
   * @example
   * ```ts
   * // For Cloudflare Workers
   * app.post('/', async (c) => {
   *   const metadata = c.req.raw.cf?.hostMetadata?
   *   ...
   * })
   * ```
   */
  raw;
  #validatedData;
  // Short name of validatedData
  #matchResult;
  routeIndex = 0;
  /**
   * `.path` can get the pathname of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#path}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const pathname = c.req.path // `/about/me`
   * })
   * ```
   */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
    this.#validatedData = {};
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && /\%/.test(param) ? tryDecodeURIComponent(param) : param;
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) {
        decoded[key] = /\%/.test(value) ? tryDecodeURIComponent(value) : value;
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? void 0;
    }
    const headerData = {};
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = /* @__PURE__ */ __name((key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    const anyCachedKey = Object.keys(bodyCache)[0];
    if (anyCachedKey) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw2[key]();
  }, "#cachedBody");
  /**
   * `.json()` can parse Request body of type `application/json`
   *
   * @see {@link https://hono.dev/docs/api/request#json}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.json()
   * })
   * ```
   */
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  /**
   * `.text()` can parse Request body of type `text/plain`
   *
   * @see {@link https://hono.dev/docs/api/request#text}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.text()
   * })
   * ```
   */
  text() {
    return this.#cachedBody("text");
  }
  /**
   * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
   *
   * @see {@link https://hono.dev/docs/api/request#arraybuffer}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.arrayBuffer()
   * })
   * ```
   */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
   * `.bytes()` parses the request body as a `Uint8Array`.
   *
   * @see {@link https://hono.dev/docs/api/request#bytes}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.bytes()
   * })
   * ```
   */
  bytes() {
    return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
  }
  /**
   * Parses the request body as a `Blob`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.blob();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#blob
   */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
   * Parses the request body as `FormData`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.formData();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#formdata
   */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
   * Adds validated data to the request.
   *
   * @param target - The target of the validation.
   * @param data - The validated data to add.
   */
  addValidatedData(target, data) {
    this.#validatedData[target] = data;
  }
  valid(target) {
    return this.#validatedData[target];
  }
  /**
   * `.url()` can get the request url strings.
   *
   * @see {@link https://hono.dev/docs/api/request#url}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const url = c.req.url // `http://localhost:8787/about/me`
   *   ...
   * })
   * ```
   */
  get url() {
    return this.raw.url;
  }
  /**
   * `.method()` can get the method name of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#method}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const method = c.req.method // `GET`
   * })
   * ```
   */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
   * `.matchedRoutes()` can return a matched route in the handler
   *
   * @deprecated
   *
   * Use matchedRoutes helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#matchedroutes}
   *
   * @example
   * ```ts
   * app.use('*', async function logger(c, next) {
   *   await next()
   *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
   *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
   *     console.log(
   *       method,
   *       ' ',
   *       path,
   *       ' '.repeat(Math.max(10 - path.length, 0)),
   *       name,
   *       i === c.req.routeIndex ? '<- respond from here' : ''
   *     )
   *   })
   * })
   * ```
   */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
   * `routePath()` can retrieve the path registered within the handler
   *
   * @deprecated
   *
   * Use routePath helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#routepath}
   *
   * @example
   * ```ts
   * app.get('/posts/:id', (c) => {
   *   return c.json({ path: c.req.routePath })
   * })
   * ```
   */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = /* @__PURE__ */ __name((value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
}, "raw");
var resolveCallback = /* @__PURE__ */ __name(async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then(
    (res) => Promise.all(
      res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))
    ).then(() => buffer[0])
  );
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
}, "resolveCallback");

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = /* @__PURE__ */ __name((contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
}, "setDefaultContentType");
var createResponseInstance = /* @__PURE__ */ __name((body, init) => new Response(body, init), "createResponseInstance");
var Context = class {
  static {
    __name(this, "Context");
  }
  #rawRequest;
  #req;
  /**
   * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
   *
   * @see {@link https://hono.dev/docs/api/context#env}
   *
   * @example
   * ```ts
   * // Environment object for Cloudflare Workers
   * app.get('*', async c => {
   *   const counter = c.env.COUNTER
   * })
   * ```
   */
  env = {};
  #var;
  finalized = false;
  /**
   * `.error` can get the error object from the middleware if the Handler throws an error.
   *
   * @see {@link https://hono.dev/docs/api/context#error}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   await next()
   *   if (c.error) {
   *     // do something...
   *   }
   * })
   * ```
   */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
   * Creates an instance of the Context class.
   *
   * @param req - The Request object.
   * @param options - Optional configuration options for the context.
   */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
   * `.req` is the instance of {@link HonoRequest}.
   */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#event}
   * The FetchEvent associated with the current request.
   *
   * @throws Will throw an error if the context does not have a FetchEvent.
   */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#executionctx}
   * The ExecutionContext associated with the current request.
   *
   * @throws Will throw an error if the context does not have an ExecutionContext.
   */
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#res}
   * The Response object for the current request.
   */
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers()
    });
  }
  /**
   * Sets the Response object for the current request.
   *
   * @param _res - The Response object to set.
   */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
   * `.render()` can create a response within a layout.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   return c.render('Hello!')
   * })
   * ```
   */
  render = /* @__PURE__ */ __name((...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  }, "render");
  /**
   * Sets the layout for the response.
   *
   * @param layout - The layout to set.
   * @returns The layout function.
   */
  setLayout = /* @__PURE__ */ __name((layout) => this.#layout = layout, "setLayout");
  /**
   * Gets the current layout for the response.
   *
   * @returns The current layout function.
   */
  getLayout = /* @__PURE__ */ __name(() => this.#layout, "getLayout");
  /**
   * `.setRenderer()` can set the layout in the custom middleware.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```tsx
   * app.use('*', async (c, next) => {
   *   c.setRenderer((content) => {
   *     return c.html(
   *       <html>
   *         <body>
   *           <p>{content}</p>
   *         </body>
   *       </html>
   *     )
   *   })
   *   await next()
   * })
   * ```
   */
  setRenderer = /* @__PURE__ */ __name((renderer) => {
    this.#renderer = renderer;
  }, "setRenderer");
  /**
   * `.header()` can set headers.
   *
   * @see {@link https://hono.dev/docs/api/context#header}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  header = /* @__PURE__ */ __name((name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  }, "header");
  status = /* @__PURE__ */ __name((status) => {
    this.#status = status;
  }, "status");
  /**
   * `.set()` can set the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   c.set('message', 'Hono is hot!!')
   *   await next()
   * })
   * ```
   */
  set = /* @__PURE__ */ __name((key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  }, "set");
  /**
   * `.get()` can use the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   const message = c.get('message')
   *   return c.text(`The message is "${message}"`)
   * })
   * ```
   */
  get = /* @__PURE__ */ __name((key) => {
    return this.#var ? this.#var.get(key) : void 0;
  }, "get");
  /**
   * `.var` can access the value of a variable.
   *
   * @see {@link https://hono.dev/docs/api/context#var}
   *
   * @example
   * ```ts
   * const result = c.var.client.oneMethod()
   * ```
   */
  // c.var.propName is a read-only
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    const responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders ?? new Headers();
    if (typeof arg === "object" && "headers" in arg) {
      const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers(arg.headers);
      for (const [key, value] of argHeaders) {
        if (key.toLowerCase() === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          responseHeaders.set(k, v);
        } else {
          responseHeaders.delete(k);
          for (const v2 of v) {
            responseHeaders.append(k, v2);
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, { status, headers: responseHeaders });
  }
  newResponse = /* @__PURE__ */ __name((...args) => this.#newResponse(...args), "newResponse");
  /**
   * `.body()` can return the HTTP response.
   * You can set headers with `.header()` and set HTTP status code with `.status`.
   * This can also be set in `.text()`, `.json()` and so on.
   *
   * @see {@link https://hono.dev/docs/api/context#body}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *   // Set HTTP status code
   *   c.status(201)
   *
   *   // Return the response body
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  body = /* @__PURE__ */ __name((data, arg, headers) => this.#newResponse(data, arg, headers), "body");
  /**
   * `.text()` can render text as `Content-Type:text/plain`.
   *
   * @see {@link https://hono.dev/docs/api/context#text}
   *
   * @example
   * ```ts
   * app.get('/say', (c) => {
   *   return c.text('Hello!')
   * })
   * ```
   */
  text = /* @__PURE__ */ __name((text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(
      text,
      arg,
      setDefaultContentType(TEXT_PLAIN, headers)
    );
  }, "text");
  /**
   * `.json()` can render JSON as `Content-Type:application/json`.
   *
   * @see {@link https://hono.dev/docs/api/context#json}
   *
   * @example
   * ```ts
   * app.get('/api', (c) => {
   *   return c.json({ message: 'Hello!' })
   * })
   * ```
   */
  json = /* @__PURE__ */ __name((object, arg, headers) => {
    return this.#newResponse(
      JSON.stringify(object),
      arg,
      setDefaultContentType("application/json", headers)
    );
  }, "json");
  html = /* @__PURE__ */ __name((html, arg, headers) => {
    const res = /* @__PURE__ */ __name((html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers)), "res");
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  }, "html");
  /**
   * `.redirect()` can Redirect, default status code is 302.
   *
   * @see {@link https://hono.dev/docs/api/context#redirect}
   *
   * @example
   * ```ts
   * app.get('/redirect', (c) => {
   *   return c.redirect('/')
   * })
   * app.get('/redirect-permanently', (c) => {
   *   return c.redirect('/', 301)
   * })
   * ```
   */
  redirect = /* @__PURE__ */ __name((location, status) => {
    const locationString = String(location);
    this.header(
      "Location",
      // Multibyes should be encoded
      // eslint-disable-next-line no-control-regex
      !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString)
    );
    return this.newResponse(null, status ?? 302);
  }, "redirect");
  /**
   * `.notFound()` can return the Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/context#notfound}
   *
   * @example
   * ```ts
   * app.get('/notfound', (c) => {
   *   return c.notFound()
   * })
   * ```
   */
  notFound = /* @__PURE__ */ __name(() => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  }, "notFound");
};

// node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
  static {
    __name(this, "UnsupportedPathError");
  }
};

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/hono-base.js
var notFoundHandler = /* @__PURE__ */ __name((c) => {
  return c.text("404 Not Found", 404);
}, "notFoundHandler");
var errorHandler = /* @__PURE__ */ __name((err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
}, "errorHandler");
var Hono = class _Hono {
  static {
    __name(this, "_Hono");
  }
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */
  router;
  getPath;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  errorHandler = errorHandler;
  /**
   * `.route()` allows grouping other Hono instance in routes.
   *
   * @see {@link https://hono.dev/docs/api/routing#grouping}
   *
   * @param {string} path - base Path
   * @param {Hono} app - other Hono instance
   * @returns {Hono} routed Hono instance
   *
   * @example
   * ```ts
   * const app = new Hono()
   * const app2 = new Hono()
   *
   * app2.get("/user", (c) => c.text("user"))
   * app.route("/api", app2) // GET /api/user
   * ```
   */
  route(path, app2) {
    const subApp = this.basePath(path);
    app2.routes.map((r) => {
      let handler;
      if (app2.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = /* @__PURE__ */ __name(async (c, next) => (await compose([], app2.errorHandler)(c, () => r.handler(c, next))).res, "handler");
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
   * `.basePath()` allows base paths to be specified.
   *
   * @see {@link https://hono.dev/docs/api/routing#base-path}
   *
   * @param {string} path - base Path
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * const api = new Hono().basePath('/api')
   * ```
   */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
   * `.onError()` handles an error and returns a customized Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#error-handling}
   *
   * @param {ErrorHandler} handler - request Handler for error
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.onError((err, c) => {
   *   console.error(`${err}`)
   *   return c.text('Custom Error Message', 500)
   * })
   * ```
   */
  onError = /* @__PURE__ */ __name((handler) => {
    this.errorHandler = handler;
    return this;
  }, "onError");
  /**
   * `.notFound()` allows you to customize a Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#not-found}
   *
   * @param {NotFoundHandler} handler - request handler for not-found
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.notFound((c) => {
   *   return c.text('Custom 404 Message', 404)
   * })
   * ```
   */
  notFound = /* @__PURE__ */ __name((handler) => {
    this.#notFoundHandler = handler;
    return this;
  }, "notFound");
  /**
   * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
   *
   * @see {@link https://hono.dev/docs/api/hono#mount}
   *
   * @param {string} path - base Path
   * @param {Function} applicationHandler - other Request Handler
   * @param {MountOptions} [options] - options of `.mount()`
   * @returns {Hono} mounted Hono instance
   *
   * @example
   * ```ts
   * import { Router as IttyRouter } from 'itty-router'
   * import { Hono } from 'hono'
   * // Create itty-router application
   * const ittyRouter = IttyRouter()
   * // GET /itty-router/hello
   * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
   *
   * const app = new Hono()
   * app.mount('/itty-router', ittyRouter.handle)
   * ```
   *
   * @example
   * ```ts
   * const app = new Hono()
   * // Send the request to another application without modification.
   * app.mount('/app', anotherApp, {
   *   replaceRequest: (req) => req,
   * })
   * ```
   */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = /* @__PURE__ */ __name((request) => request, "replaceRequest");
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = this.getPath(request).slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = /* @__PURE__ */ __name(async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    }, "handler");
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then(
        (resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
      ).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error(
            "Context is not finalized. Did you forget to return a Response object or `await next()`?"
          );
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
   * `.fetch()` will be entry point of your app.
   *
   * @see {@link https://hono.dev/docs/api/hono#fetch}
   *
   * @param {Request} request - request Object of request
   * @param {Env} Env - env Object
   * @param {ExecutionContext} - context of execution
   * @returns {Response | Promise<Response>} response of request
   *
   */
  fetch = /* @__PURE__ */ __name((request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  }, "fetch");
  /**
   * `.request()` is a useful method for testing.
   * You can pass a URL or pathname to send a GET request.
   * app will return a Response object.
   * ```ts
   * test('GET /hello is ok', async () => {
   *   const res = await app.request('/hello')
   *   expect(res.status).toBe(200)
   * })
   * ```
   * @see https://hono.dev/docs/api/hono#request
   */
  request = /* @__PURE__ */ __name((input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(
      new Request(
        /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
        requestInit
      ),
      Env,
      executionCtx
    );
  }, "request");
  /**
   * `.fire()` automatically adds a global fetch event listener.
   * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
   * @deprecated
   * Use `fire` from `hono/service-worker` instead.
   * ```ts
   * import { Hono } from 'hono'
   * import { fire } from 'hono/service-worker'
   *
   * const app = new Hono()
   * // ...
   * fire(app)
   * ```
   * @see https://hono.dev/docs/api/hono#fire
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
   * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
   */
  fire = /* @__PURE__ */ __name(() => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  }, "fire");
};

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = /* @__PURE__ */ __name(((method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  }), "match2");
  this.match = match2;
  return match2(method, path);
}
__name(match, "match");

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
__name(compareKey, "compareKey");
var Node = class _Node {
  static {
    __name(this, "_Node");
  }
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, pathErrorCheckOnly) {
    if (tokens.length === 0) {
      if (this.#index !== void 0) {
        throw PATH_ERROR;
      }
      if (pathErrorCheckOnly) {
        return;
      }
      this.#index = index;
      return;
    }
    const [token, ...restTokens] = tokens;
    const pattern = token === "*" ? restTokens.length === 0 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
    let node;
    if (pattern) {
      const name = pattern[1];
      let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
      if (name && pattern[2]) {
        if (regexpStr === ".*") {
          throw PATH_ERROR;
        }
        regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
        if (/\((?!\?:)/.test(regexpStr)) {
          throw PATH_ERROR;
        }
      }
      node = this.#children[regexpStr];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[regexpStr] = new _Node();
        if (name !== "") {
          node.#varIndex = context.varIndex++;
        }
      }
      if (!pathErrorCheckOnly && name !== "") {
        paramMap.push([name, node.#varIndex]);
      }
    } else {
      node = this.#children[token];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[token] = new _Node();
      }
    }
    node.insert(restTokens, index, paramMap, context, pathErrorCheckOnly);
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      return (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + c.buildRegExpStr();
    });
    if (typeof this.#index === "number") {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  static {
    __name(this, "Trie");
  }
  #context = { varIndex: 0 };
  #root = new Node();
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [];
    for (let i = 0; ; ) {
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, index, paramAssoc, this.#context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};

// node_modules/hono/dist/router/reg-exp-router/router.js
var nullMatcher = [/^$/, [], /* @__PURE__ */ Object.create(null)];
var wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(
    path === "*" ? "" : `^${path.replace(
      /\/\*$|([.\\+*[^\]$()])/g,
      (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)"
    )}$`
  );
}
__name(buildWildcardRegExp, "buildWildcardRegExp");
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
__name(clearWildcardRegExpCache, "clearWildcardRegExpCache");
function buildMatcherFromPreprocessedRoutes(routes) {
  const trie = new Trie();
  const handlerData = [];
  if (routes.length === 0) {
    return nullMatcher;
  }
  const routesWithStaticPathFlag = routes.map(
    (route) => [!/\*|\/:/.test(route[0]), ...route]
  ).sort(
    ([isStaticA, pathA], [isStaticB, pathB]) => isStaticA ? 1 : isStaticB ? -1 : pathA.length - pathB.length
  );
  const staticMap = /* @__PURE__ */ Object.create(null);
  for (let i = 0, j = -1, len = routesWithStaticPathFlag.length; i < len; i++) {
    const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i];
    if (pathErrorCheckOnly) {
      staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
    } else {
      j++;
    }
    let paramAssoc;
    try {
      paramAssoc = trie.insert(path, j, pathErrorCheckOnly);
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
    if (pathErrorCheckOnly) {
      continue;
    }
    handlerData[j] = handlers.map(([h, paramCount]) => {
      const paramIndexMap = /* @__PURE__ */ Object.create(null);
      paramCount -= 1;
      for (; paramCount >= 0; paramCount--) {
        const [key, value] = paramAssoc[paramCount];
        paramIndexMap[key] = value;
      }
      return [h, paramIndexMap];
    });
  }
  const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
  for (let i = 0, len = handlerData.length; i < len; i++) {
    for (let j = 0, len2 = handlerData[i].length; j < len2; j++) {
      const map = handlerData[i][j]?.[1];
      if (!map) {
        continue;
      }
      const keys = Object.keys(map);
      for (let k = 0, len3 = keys.length; k < len3; k++) {
        map[keys[k]] = paramReplacementMap[map[keys[k]]];
      }
    }
  }
  const handlerMap = [];
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlerData[indexReplacementMap[i]];
  }
  return [regexp, handlerMap, staticMap];
}
__name(buildMatcherFromPreprocessedRoutes, "buildMatcherFromPreprocessedRoutes");
function findMiddleware(middleware, path) {
  if (!middleware) {
    return void 0;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return void 0;
}
__name(findMiddleware, "findMiddleware");
var RegExpRouter = class {
  static {
    __name(this, "RegExpRouter");
  }
  name = "RegExpRouter";
  #middleware;
  #routes;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      ;
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      if (method === METHOD_NAME_ALL) {
        Object.keys(middleware).forEach((m) => {
          middleware[m][path] ||= findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        });
      } else {
        middleware[method][path] ||= findMiddleware(middleware[method], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
      }
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach(
            (p) => re.test(p) && routes[m][p].push([handler, paramCount])
          );
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length; i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          routes[m][path2] ||= [
            ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
          ];
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = void 0;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const routes = [];
    let hasOwnRoute = method === METHOD_NAME_ALL;
    [this.#middleware, this.#routes].forEach((r) => {
      const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method][path]]) : [];
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true;
        routes.push(...ownRoute);
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(
          ...Object.keys(r[METHOD_NAME_ALL]).map((path) => [path, r[METHOD_NAME_ALL][path]])
        );
      }
    });
    if (!hasOwnRoute) {
      return null;
    } else {
      return buildMatcherFromPreprocessedRoutes(routes);
    }
  }
};

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  static {
    __name(this, "SmartRouter");
  }
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
};

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = /* @__PURE__ */ Object.create(null);
var hasChildren = /* @__PURE__ */ __name((children) => {
  for (const _ in children) {
    return true;
  }
  return false;
}, "hasChildren");
var Node2 = class _Node2 {
  static {
    __name(this, "_Node");
  }
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length; i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new _Node2();
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== void 0) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length; k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              this.#pushHandlerSets(handlerSets, astNode, method, node.#params);
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          if (matcher instanceof RegExp) {
            if (partOffsets === null) {
              partOffsets = new Array(len);
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.substring(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (hasChildren(child.#children)) {
                child.#params = params;
                const componentCount = m[0].match(/\//)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  params,
                  node.#params
                );
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  static {
    __name(this, "TrieRouter");
  }
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node2();
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length; i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// node_modules/hono/dist/hono.js
var Hono2 = class extends Hono {
  static {
    __name(this, "Hono");
  }
  /**
   * Creates an instance of the Hono class.
   *
   * @param options - Optional configuration options for the Hono instance.
   */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()]
    });
  }
};

// server/src/config.js
var config = {
  salesforce: {
    apiVersion: "v60.0"
  },
  jobStatusValues: [
    "Pending Customer Approval",
    "Quoted",
    "Parts Ordered",
    "Ready to be scheduled",
    "Scheduled",
    "In Progress",
    "Installation Completed",
    "Waiting on Payment"
  ],
  // ---- Opportunity (the job) field API names ----
  fields: {
    oppName: "Name",
    oppStatus: "Project_Status__c",
    oppScheduledDate: "Scheduled_Project_Start_Date__c",
    oppLid: "LID__c",
    addrStreet: "Job_Street_Address2__c",
    addrCity: "Job_City__c",
    addrState: "Job_State__c",
    addrZip: "Job_Zip_Code__c",
    oppType: "Opportunity_Type__c",
    // ---- Field Squared integration ----
    // External ID field on Opportunity — Text(50), External ID, Unique.
    // Create in SF Setup → Object Manager → Opportunity → Fields & Relationships.
    oppFsTaskId: "FS_Task_Id__c",
    // WO number field — used as tertiary match fallback.
    oppWoNumber: "WO_Number__c",
    // Raw FS task status + its LastUpdated timestamp, written ONLY by the FS
    // sync path (fsSync.js + the manual fs-link endpoint) — never by the
    // dispatch-status write path. Read-only snapshot for the drift badge.
    // Create in SF: FS_Status__c (Text), FS_Last_Modified__c (DateTime).
    oppFsStatus: "FS_Status__c",
    oppFsLastModified: "FS_Last_Modified__c"
  },
  // FS user ObjectId → SF technician name.
  // Excludes Account Services (FL9_cUxsT0OmJLSNE9070w) and Paul Aldridge
  // (1bxTwRMv2dt6hpNYrZMI-QAA-Q) — not field techs, not synced.
  fsTechUsers: {
    "Vy7n4YPQsEa-pjadx4BAGA": "Pedro Ortiz",
    "GemUv2xBrz3B9r8zIaKTJAAAJA": "Mike Ellenburg",
    "ICA8ug9SUEGTj5jtgOA-ew": "Perry Floyd",
    "JnO4ynVJ-EuO73og_pdGFw": "Joseph Wyatt",
    "7b1I9-cJ4UK0slqoKZIPGQ": "Jay Ebeling",
    "lGUm5YLzTEmfuY6mNZ2R2QAA2Q": "Mason Ebeling",
    "EhHzICfmtUG6YTGPt1Y5wQ": "Gabor Fogorasi",
    "F68pM1uEZ0is351UcbPrVg": "Casey Berrier",
    "fGIGr86tOft4m2VPMlGTZQAAZQ": "Skip Cashion",
    "UnYYVeGKq-9AeErKQAIl6AAA6A": "Adrian Van Luven"
  },
  // ---- Job_Assignment__c ----
  objects: {
    assignment: "Job_Assignment__c",
    assignmentChildRelationship: "Job_Assignments__r",
    assignmentOppLookup: "Opportunity__c",
    assignmentTechLookup: "Technician__c",
    assignmentTechRelationship: "Technician__r",
    assignmentDate: "Work_Date__c",
    assignmentStartTime: "Start_Time__c",
    assignmentCompleted: "Completed__c",
    technician: "Technician__c",
    technicianActive: "Active__c"
  },
  // ---- Schedule_Request__c (chalkboard tech <-> office negotiation) ----
  scheduleRequest: {
    sobject: "Schedule_Request__c",
    job: "Job__c",
    // lookup -> Opportunity
    jobRelationship: "Job__r",
    type: "Type__c",
    // picklist: Job | Time off
    tech: "Technician__c",
    techRelationship: "Technician__r",
    requestedBy: "Requested_By__c",
    requestedByRelationship: "Requested_By__r",
    proposedDate: "Proposed_Date__c",
    proposedStart: "Proposed_Start__c",
    proposedEnd: "Proposed_End__c",
    status: "Status__c",
    lastOfferBy: "Last_Offer_By__c",
    // picklist: Tech | Office
    note: "Note__c",
    // technician's note
    officeNote: "Office_Note__c",
    // office's counter/deny reason
    resolvedAt: "Resolved_At__c",
    resultingAssignment: "Resulting_Assignment__c"
  }
};

// server/src/salesforce.js
var mem = { token: null, instanceUrl: null, expires: 0 };
function createSalesforce(env) {
  const KV = env.SF_TOKENS;
  async function getToken() {
    const now = Date.now();
    if (mem.token && now < mem.expires) return mem;
    if (KV) {
      const hit = await KV.get("sf_token", "json");
      if (hit && now < hit.expires) {
        mem = hit;
        return mem;
      }
    }
    const loginUrl = env.SF_LOGIN_URL || "https://login.salesforce.com";
    const clientId = env.SF_CLIENT_ID;
    const clientSecret = env.SF_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Missing SF_CLIENT_ID / SF_CLIENT_SECRET");
    }
    const base = loginUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret
      })
    });
    if (!res.ok) throw new Error(`Salesforce auth failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    mem = {
      token: data.access_token,
      instanceUrl: data.instance_url,
      expires: Date.now() + 30 * 60 * 1e3
    };
    if (KV) await KV.put("sf_token", JSON.stringify(mem), { expirationTtl: 1800 });
    return mem;
  }
  __name(getToken, "getToken");
  async function sfFetch(path, options = {}) {
    const { token, instanceUrl } = await getToken();
    return fetch(`${instanceUrl}/services/data/${config.salesforce.apiVersion}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers || {}
      }
    });
  }
  __name(sfFetch, "sfFetch");
  return {
    async query(soql) {
      const res = await sfFetch(`/query?q=${encodeURIComponent(soql)}`);
      if (!res.ok) throw new Error(`SOQL failed: ${res.status} ${await res.text()}`);
      const first = await res.json();
      const records = first.records;
      let next = first.nextRecordsUrl;
      while (next) {
        const { token, instanceUrl } = await getToken();
        const page = await fetch(`${instanceUrl}${next}`, {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
        });
        if (!page.ok) throw new Error(`SOQL pagination failed: ${page.status} ${await page.text()}`);
        const data = await page.json();
        records.push(...data.records);
        next = data.nextRecordsUrl;
      }
      return records;
    },
    async createRecord(object, fields) {
      const res = await sfFetch(`/sobjects/${object}`, { method: "POST", body: JSON.stringify(fields) });
      if (!res.ok) throw new Error(`Create failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async deleteRecord(object, id) {
      const res = await sfFetch(`/sobjects/${object}/${id}`, { method: "DELETE" });
      if (res.status !== 204) throw new Error(`Delete failed: ${res.status} ${await res.text()}`);
      return { success: true };
    },
    async updateRecord(object, id, fields) {
      const res = await sfFetch(`/sobjects/${object}/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
      if (res.status !== 204) throw new Error(`Update failed: ${res.status} ${await res.text()}`);
      return { success: true };
    },
    async raw(path) {
      const res = await sfFetch(path);
      if (!res.ok) throw new Error(`SF request failed: ${res.status} ${await res.text()}`);
      return res.json();
    }
  };
}
__name(createSalesforce, "createSalesforce");

// server/src/fieldSquared.js
var FS_BASE = "https://api.fieldsquared.com";
var mem2 = { token: null, expires: 0 };
function createFs(env) {
  const KV = env.FS_TOKENS;
  const workspace = env.FS_WORKSPACE;
  if (!workspace) throw new Error("Missing FS_WORKSPACE env var");
  if (!env.FS_EMAIL || !env.FS_PASSWORD) throw new Error("Missing FS_EMAIL / FS_PASSWORD env vars");
  async function fetchNewToken() {
    const res = await fetch(`${FS_BASE}/Authentication`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ Email: env.FS_EMAIL, Password: env.FS_PASSWORD })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`FS auth failed: ${res.status} ${text}`);
    const data = JSON.parse(text);
    return data.AuthToken;
  }
  __name(fetchNewToken, "fetchNewToken");
  async function getToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && mem2.token && now < mem2.expires) return mem2.token;
    if (!forceRefresh && KV) {
      const hit = await KV.get("fs_token", "json");
      if (hit && now < hit.expires) {
        mem2 = hit;
        return mem2.token;
      }
    }
    const token = await fetchNewToken();
    mem2 = { token, expires: now + 55 * 60 * 1e3 };
    if (KV) await KV.put("fs_token", JSON.stringify(mem2), { expirationTtl: 3300 });
    return token;
  }
  __name(getToken, "getToken");
  async function fsFetch(path, options = {}, retried = false) {
    const token = await getToken();
    const res = await fetch(`${FS_BASE}/${workspace}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json",
        "X-Workspace": workspace,
        "X-Auth-Token": token,
        "X-Client": env.FS_CLIENT || "568",
        ...options.headers || {}
      }
    });
    if (res.status === 401 && !retried) {
      mem2 = { token: null, expires: 0 };
      if (KV) await KV.delete("fs_token");
      return fsFetch(path, options, true);
    }
    return res;
  }
  __name(fsFetch, "fsFetch");
  async function getTask(externalId) {
    const res = await fsFetch(`/Task/${externalId}`);
    if (!res.ok) throw new Error(`FS getTask failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  __name(getTask, "getTask");
  async function listModified(since, taskType) {
    let qs = `modifiedsince=${since}`;
    if (taskType) qs += `&tasktypes=${encodeURIComponent(taskType)}`;
    const res = await fsFetch(`/api/task?${qs}`);
    if (!res.ok) throw new Error(`FS listModified failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  __name(listModified, "listModified");
  async function updateStatus(externalId, name, taskType, status) {
    const res = await fsFetch(`/api/task/${externalId}`, {
      method: "POST",
      body: JSON.stringify({ Name: name, TaskType: taskType, Status: status })
    });
    const errHeader = res.headers.get("x-errorstatusmessage");
    if (errHeader) throw new Error(errHeader);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return true;
  }
  __name(updateStatus, "updateStatus");
  async function updateUsers(externalId, name, taskType, userIds) {
    const res = await fsFetch(`/api/task/${externalId}`, {
      method: "POST",
      body: JSON.stringify({ Name: name, TaskType: taskType, Users: userIds })
    });
    const errHeader = res.headers.get("x-errorstatusmessage");
    if (errHeader) throw new Error(errHeader);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return true;
  }
  __name(updateUsers, "updateUsers");
  async function patchTask(externalId, fullTask, fields) {
    const bodyObj = {
      ...fullTask,
      ...fields,
      ExternalId: externalId,
      BasedOn: fullTask.VersionId
    };
    const res = await fsFetch(`/Task/${externalId}`, {
      method: "POST",
      body: JSON.stringify(bodyObj)
    });
    const errHeader = res.headers.get("x-errorstatusmessage");
    const raw2 = await res.text();
    if (errHeader || !res.ok) {
      console.error("[patchTask] FS rejected", {
        externalId,
        httpStatus: res.status,
        errHeader,
        responseBody: raw2.slice(0, 500)
      });
      throw new Error(errHeader || `${res.status} ${raw2}`);
    }
    return true;
  }
  __name(patchTask, "patchTask");
  async function listDocuments(type) {
    const qs = type ? `?type=${encodeURIComponent(type)}` : "";
    const res = await fsFetch(`/api/document${qs}`);
    const body = await res.text();
    const errHeader = res.headers.get("x-errorstatusmessage");
    return { status: res.status, ok: res.ok, errHeader, body };
  }
  __name(listDocuments, "listDocuments");
  async function getDocument(externalId) {
    const res = await fsFetch(`/api/document/${externalId}`);
    const body = await res.text();
    const errHeader = res.headers.get("x-errorstatusmessage");
    return { status: res.status, ok: res.ok, errHeader, body };
  }
  __name(getDocument, "getDocument");
  async function rawDocumentQuery(qs) {
    const res = await fsFetch(`/api/document${qs ? `?${qs}` : ""}`);
    const body = await res.text();
    const errHeader = res.headers.get("x-errorstatusmessage");
    return { status: res.status, ok: res.ok, errHeader, body };
  }
  __name(rawDocumentQuery, "rawDocumentQuery");
  return {
    getToken,
    getTask,
    listModified,
    updateStatus,
    updateUsers,
    patchTask,
    // TEMPORARY — remove along with the /debug/documents route.
    listDocuments,
    getDocument,
    rawDocumentQuery
  };
}
__name(createFs, "createFs");

// server/src/statusMap.js
var FS_TO_SF = {
  "Entered": "Ready to be scheduled",
  "Scheduled": "Scheduled",
  "Assigned": "Scheduled",
  "En-Route": "In Progress",
  "In-Progress": "In Progress",
  "Rescheduled": "Scheduled",
  "Return Trip": "In Progress",
  "Completed": "Installation Completed",
  "In-review": null,
  "Billing Completed": "Waiting on Payment",
  // special case — see reconcile
  "Warranty": null
};
var SF_TO_FS = {
  "Pending Customer Approval": "Entered",
  "Quoted": "Entered",
  "Parts Ordered": "Entered",
  "Ready to be scheduled": "Entered",
  "Scheduled": "Scheduled",
  "In Progress": "In-Progress",
  "Installation Completed": "Completed",
  "Waiting on Payment": "Billing Completed",
  "Billing Complete": "Billing Completed",
  "Project Complete": "Billing Completed"
};
var SF_TERMINAL_LOCKED = /* @__PURE__ */ new Set(["Billing Complete", "Project Complete"]);
function areEquivalent(fsStatus, sfStatus) {
  if (fsStatus === "Billing Completed" && sfStatus === "Billing Complete") return true;
  if (fsStatus === "Billing Completed" && sfStatus === "Waiting on Payment") return true;
  const fsMapped = FS_TO_SF[fsStatus];
  const sfMapped = SF_TO_FS[sfStatus];
  if (fsMapped && fsMapped === sfStatus) return true;
  if (sfMapped && sfMapped === fsStatus) return true;
  return false;
}
__name(areEquivalent, "areEquivalent");
function sfToFsStatus(sfStatus, hasAssignments) {
  if (sfStatus === "Scheduled" && hasAssignments) return "Assigned";
  return SF_TO_FS[sfStatus] ?? null;
}
__name(sfToFsStatus, "sfToFsStatus");
function reconcile(fsStatus, sfStatus, fsLastUpdated, sfLastModifiedDate) {
  const fsMapped = FS_TO_SF[fsStatus];
  const sfMapped = SF_TO_FS[sfStatus];
  if (fsMapped === null || fsMapped === void 0 && !sfMapped) {
    return { action: "skip", reason: `No SF mapping for FS status "${fsStatus}"` };
  }
  if (sfMapped === void 0) {
    return { action: "skip", reason: `No FS mapping for SF status "${sfStatus}"` };
  }
  if (areEquivalent(fsStatus, sfStatus)) return { action: "noop" };
  if (SF_TERMINAL_LOCKED.has(sfStatus)) {
    return { action: "skip", reason: `SF status "${sfStatus}" is terminal \u2014 not writable from FS` };
  }
  const fsTime = new Date(fsLastUpdated).getTime();
  const sfTime = new Date(sfLastModifiedDate).getTime();
  if (Number.isNaN(fsTime) || Number.isNaN(sfTime) || fsTime === sfTime) {
    return { action: "noop" };
  }
  if (fsTime > sfTime) {
    const sfTarget = FS_TO_SF[fsStatus];
    if (!sfTarget) return { action: "skip", reason: `No SF mapping for FS="${fsStatus}"` };
    return { action: "write", target: "sf", value: sfTarget };
  }
  const fsTarget = SF_TO_FS[sfStatus];
  if (!fsTarget) return { action: "skip", reason: `No FS mapping for SF="${sfStatus}"` };
  return { action: "write", target: "fs", value: fsTarget };
}
__name(reconcile, "reconcile");

// server/src/fsSync.js
var f = config.fields;
var o = config.objects;
var ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1e3;
var OVERLAP_MS = 5 * 60 * 1e3;
var MIN_INTERVAL_MS = 60 * 1e3;
var MAX_UNLINKED_PER_RUN = 30;
var RECONCILE_WINDOW_MS = 10 * 60 * 1e3;
var fsTechUsers = config.fsTechUsers;
var techNameToFsId = Object.fromEntries(
  Object.entries(fsTechUsers).map(([fsId, name]) => [name, fsId])
);
function parseWoNum(name) {
  const m = name && name.match(/^WO\s+(\d+)/i);
  return m ? m[1] : null;
}
__name(parseWoNum, "parseWoNum");
function isLinkable(task) {
  return task.Name && task.Name.trim().length > 3;
}
__name(isLinkable, "isLinkable");
function findInSf(sfByName, sfByWoNum, task) {
  const byName = sfByName.get(task.Name);
  if (byName) return byName;
  const wo = parseWoNum(task.Name);
  return wo ? sfByWoNum.get(wo) ?? null : null;
}
__name(findInSf, "findInSf");
async function runFsSync(env) {
  const KV = env.SF_TOKENS;
  const fs = createFs(env);
  const sf = createSalesforce(env);
  const lastRunKey = "fs_sync_last_run";
  const stored = await KV.get(lastRunKey);
  if (stored && Date.now() - new Date(stored).getTime() < MIN_INTERVAL_MS) return;
  await KV.put(lastRunKey, (/* @__PURE__ */ new Date()).toISOString());
  const since = stored ? new Date(new Date(stored).getTime() - OVERLAP_MS).toISOString() : new Date(Date.now() - ONE_YEAR_MS).toISOString();
  let tasks;
  try {
    tasks = await fs.listModified(since);
  } catch (e) {
    console.error("[fs-sync] listModified failed:", e.message);
    return;
  }
  const linkable = tasks.filter(isLinkable);
  console.log(`[fs-sync] ${tasks.length} FS tasks, ${linkable.length} linkable`);
  let linkedOpps;
  try {
    linkedOpps = await sf.query(
      `SELECT Id, ${f.oppFsTaskId}, ${f.oppStatus}, ${f.oppFsStatus}, LastModifiedDate
       FROM Opportunity WHERE ${f.oppFsTaskId} != null LIMIT 2000`
    );
  } catch (e) {
    console.error("[fs-sync] bulk linked-opps query failed:", e.message);
    return;
  }
  const linkedMap = new Map(linkedOpps.map((row) => [row[f.oppFsTaskId], row]));
  const linkedIds = new Set(linkedMap.keys());
  console.log(`[fs-sync] ${linkedMap.size} already linked`);
  const NO_MATCH_KEY = "fs_no_match_ids";
  const skipRaw = await KV.get(NO_MATCH_KEY, "json");
  const skipIds = new Set(Array.isArray(skipRaw) ? skipRaw : []);
  const unlinked = linkable.filter((t) => !linkedIds.has(t.ExternalId) && !skipIds.has(t.ExternalId));
  const toMatch = unlinked.slice(0, MAX_UNLINKED_PER_RUN);
  if (unlinked.length > MAX_UNLINKED_PER_RUN) {
    console.log(`[fs-sync] processing ${MAX_UNLINKED_PER_RUN} of ${unlinked.length} unlinked this run (${skipIds.size} previously skipped)`);
  }
  let sfByName = /* @__PURE__ */ new Map();
  let sfByWoNum = /* @__PURE__ */ new Map();
  if (toMatch.length > 0) {
    try {
      const nameList = toMatch.map((t) => `'${t.Name.replace(/'/g, "\\'")}'`).join(",");
      const woNums = [...new Set(toMatch.map((t) => parseWoNum(t.Name)).filter(Boolean))];
      const woLikes = woNums.map((n) => `${f.oppName} LIKE 'WO ${n}%'`);
      const nameFilter = `${f.oppName} IN (${nameList})`;
      const nameOrWo = woLikes.length ? `(${nameFilter} OR ${woLikes.join(" OR ")})` : nameFilter;
      const boardStatuses = config.jobStatusValues.map((s) => `'${s}'`).join(",");
      const matchOpps = await sf.query(
        `SELECT Id, ${f.oppName}, ${f.oppStatus}
         FROM Opportunity
         WHERE ${f.oppFsTaskId} = null
           AND ${f.oppStatus} IN (${boardStatuses})
           AND ${nameOrWo}`
      );
      sfByName = new Map(matchOpps.map((o4) => [o4[f.oppName], o4]));
      for (const opp of matchOpps) {
        const wo = parseWoNum(opp[f.oppName]);
        if (wo && !sfByWoNum.has(wo)) sfByWoNum.set(wo, opp);
      }
    } catch (e) {
      console.error("[fs-sync] batch match query failed:", e.message);
    }
  }
  let linked = 0;
  const noMatchIds = [];
  for (const task of toMatch) {
    try {
      const sfOpp = findInSf(sfByName, sfByWoNum, task);
      if (!sfOpp) {
        noMatchIds.push(task.ExternalId);
        continue;
      }
      await sf.updateRecord("Opportunity", sfOpp.Id, {
        [f.oppFsTaskId]: task.ExternalId,
        [f.oppFsStatus]: task.Status ?? null,
        [f.oppFsLastModified]: task.LastUpdated ?? null
      });
      console.log(`[fs-sync] linked: "${task.Name}" \u2192 SF ${sfOpp.Id}`);
      linked++;
    } catch (e) {
      console.error(`[fs-sync] error on "${task.Name}" (${task.ExternalId}):`, e.message);
    }
  }
  console.log(`[fs-sync] done linking \u2014 ${linked} linked, ${noMatchIds.length} no SF match`);
  if (noMatchIds.length > 0) {
    const updated = [...skipIds, ...noMatchIds];
    await KV.put(NO_MATCH_KEY, JSON.stringify(updated), { expirationTtl: 86400 });
  }
  const recentCutoff = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const toReconcile = linkable.filter(
    (t) => linkedMap.has(t.ExternalId) && (t.LastUpdated || "") >= recentCutoff
  );
  const queued = new Set(toReconcile.map((t) => t.ExternalId));
  const backfillIds = linkedOpps.filter((o4) => !o4[f.oppFsStatus] && !queued.has(o4[f.oppFsTaskId])).map((o4) => o4[f.oppFsTaskId]).slice(0, MAX_UNLINKED_PER_RUN);
  for (const externalId of backfillIds) toReconcile.push({ ExternalId: externalId });
  if (toReconcile.length === 0) return;
  console.log(`[fs-sync] reconciling status + assignments for ${toReconcile.length} tasks (${backfillIds.length} snapshot backfill)`);
  let sfTechIdByName = null;
  for (const task of toReconcile) {
    try {
      const sfOpp = linkedMap.get(task.ExternalId);
      const [fullTask, sfAssignments] = await Promise.all([
        fs.getTask(task.ExternalId),
        sf.query(
          `SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name
           FROM ${o.assignment}
           WHERE ${o.assignmentOppLookup} = '${sfOpp.Id}'`
        )
      ]);
      const rec = reconcile(fullTask.Status, sfOpp[f.oppStatus], fullTask.LastUpdated, sfOpp.LastModifiedDate);
      const fsSnapshot = { [f.oppFsStatus]: fullTask.Status ?? null, [f.oppFsLastModified]: fullTask.LastUpdated ?? null };
      if (rec.action === "write" && rec.target === "sf") {
        await sf.updateRecord("Opportunity", sfOpp.Id, { [f.oppStatus]: rec.value, ...fsSnapshot });
        console.log(`[fs-sync] status SF\u2190FS: "${fullTask.Status}" \u2192 "${rec.value}" on ${sfOpp.Id}`);
      } else {
        await sf.updateRecord("Opportunity", sfOpp.Id, fsSnapshot);
        if (rec.action === "write" && rec.target === "fs") {
          const fsTarget = sfToFsStatus(sfOpp[f.oppStatus], sfAssignments.length > 0);
          if (fsTarget) {
            await fs.updateStatus(task.ExternalId, fullTask.Name, fullTask.TaskType, fsTarget);
            console.log(`[fs-sync] status FS\u2190SF: "${sfOpp[f.oppStatus]}" \u2192 "${fsTarget}" on ${task.ExternalId}`);
          }
        }
      }
      const toFsId = /* @__PURE__ */ __name((u) => typeof u === "string" ? u : u?.ObjectId ?? null, "toFsId");
      const fsUserIds = new Set(
        (Array.isArray(fullTask.Users) ? fullTask.Users : []).map(toFsId).filter((uid) => uid && uid in fsTechUsers)
      );
      const sfAssignedByName = new Map(
        sfAssignments.map((a) => [a[o.assignmentTechRelationship]?.Name, a]).filter(([name]) => !!name)
      );
      for (const fsUserId of fsUserIds) {
        const techName = fsTechUsers[fsUserId];
        if (sfAssignedByName.has(techName)) continue;
        if (!sfTechIdByName) {
          const rows = await sf.query(
            `SELECT Id, Name FROM ${o.technician} WHERE ${o.technicianActive} = true`
          );
          sfTechIdByName = Object.fromEntries(rows.map((t) => [t.Name, t.Id]));
        }
        const sfTechId = sfTechIdByName[techName];
        if (sfTechId) {
          await sf.createRecord(o.assignment, {
            [o.assignmentOppLookup]: sfOpp.Id,
            [o.assignmentTechLookup]: sfTechId,
            [o.assignmentStartTime]: "07:00:00.000Z"
          });
          console.log(`[fs-sync] added assignment: ${techName} \u2192 ${sfOpp.Id}`);
        } else {
          console.warn(`[fs-sync] no SF tech ID for "${techName}" \u2014 skipping`);
        }
      }
      for (const [techName, assignmentRec] of sfAssignedByName) {
        const fsUserId = techNameToFsId[techName];
        if (!fsUserId) continue;
        if (!fsUserIds.has(fsUserId)) {
          await sf.deleteRecord(o.assignment, assignmentRec.Id);
          console.log(`[fs-sync] removed assignment: ${techName} from ${sfOpp.Id}`);
        }
      }
    } catch (e) {
      console.error(`[fs-sync] error reconciling assignments for ${task.ExternalId}:`, e.message);
    }
  }
}
__name(runFsSync, "runFsSync");

// server/src/assignments.js
var f2 = config.fields;
var o2 = config.objects;
var esc = /* @__PURE__ */ __name((s) => String(s).replace(/'/g, "\\'"), "esc");
var normTime = /* @__PURE__ */ __name((v) => v ? String(v).slice(0, 5) : null, "normTime");
var toSfTime = /* @__PURE__ */ __name((hhmm) => hhmm ? `${hhmm}:00.000Z` : null, "toSfTime");
var fsUserByTechName = Object.fromEntries(
  Object.entries(config.fsTechUsers).map(([fsId, name]) => [name, fsId])
);
function nthSunday(year, month, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = first.getUTCDay();
  return new Date(Date.UTC(year, month - 1, (day === 0 ? 1 : 8 - day) + (n - 1) * 7));
}
__name(nthSunday, "nthSunday");
function easternOffsetHours(dateStr) {
  const year = +dateStr.slice(0, 4);
  const d = /* @__PURE__ */ new Date(`${dateStr}T12:00:00Z`);
  return d >= nthSunday(year, 3, 2) && d < nthSunday(year, 11, 1) ? 4 : 5;
}
__name(easternOffsetHours, "easternOffsetHours");
function toFsDateTime(dateStr, localTime) {
  const [hh, mm] = localTime.split(":").map(Number);
  const h = hh + easternOffsetHours(dateStr);
  if (h < 24) return `${dateStr}T${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`;
  const next = new Date((/* @__PURE__ */ new Date(`${dateStr}T00:00:00Z`)).getTime() + 864e5);
  return `${next.toISOString().slice(0, 10)}T${String(h - 24).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`;
}
__name(toFsDateTime, "toFsDateTime");
function fsObjectId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(fsObjectId, "fsObjectId");
function buildFsSchedules(task, isoDate, localTime = "08:00") {
  if (!isoDate) return null;
  const start = toFsDateTime(isoDate, localTime);
  const h = parseInt(start.slice(11, 13), 10);
  const end = start.slice(0, 11) + String((h + 1) % 24).padStart(2, "0") + start.slice(13);
  const existing = Array.isArray(task.Schedules) ? task.Schedules[0] : null;
  const toId = /* @__PURE__ */ __name((u) => typeof u === "string" ? u : u?.ObjectId ?? null, "toId");
  if (existing) {
    return [{
      ...existing.ObjectId ? { ObjectId: existing.ObjectId } : {},
      Start: start,
      End: end,
      Users: Array.isArray(existing.Users) ? existing.Users.map(toId).filter(Boolean) : [],
      Teams: existing.Teams ?? [],
      Data: existing.Data ?? {},
      TimeZone: existing.TimeZone ?? ""
    }];
  }
  return [{ ObjectId: fsObjectId(), Start: start, End: end, Users: [], Teams: [], Data: {}, TimeZone: "" }];
}
__name(buildFsSchedules, "buildFsSchedules");
async function createAssignment(env, oppId, {
  technicianId,
  workDate,
  startTime,
  status,
  scheduledDate,
  deriveScheduledDate = false
}) {
  if (oppId === env.TIME_OFF_OPPORTUNITY_ID) {
    status = null;
    scheduledDate = null;
    deriveScheduledDate = false;
  }
  const sf = createSalesforce(env);
  const fields = {
    [o2.assignmentOppLookup]: oppId,
    [o2.assignmentTechLookup]: technicianId,
    [o2.assignmentStartTime]: toSfTime(startTime || "07:00")
  };
  if (typeof workDate !== "undefined") {
    fields[o2.assignmentDate] = workDate === "" ? null : workDate;
  }
  const result = await sf.createRecord(o2.assignment, fields);
  const createdId = result?.id;
  let assignmentRec = null;
  try {
    const recs = await sf.query(
      `SELECT Id, ${o2.assignmentTechLookup}, ${o2.assignmentDate}, ${o2.assignmentStartTime},
              ${o2.assignmentCompleted}, ${o2.assignmentTechRelationship}.Name
       FROM ${o2.assignment} WHERE Id='${esc(createdId)}'`
    );
    if (recs?.[0]) {
      const r = recs[0];
      assignmentRec = {
        assignmentId: r.Id,
        technicianId: r[o2.assignmentTechLookup],
        technicianName: r[o2.assignmentTechRelationship]?.Name ?? null,
        workDate: r[o2.assignmentDate] ?? null,
        startTime: normTime(r[o2.assignmentStartTime]) || "07:00",
        completed: r[o2.assignmentCompleted] === true
      };
    }
  } catch (e) {
    console.log("[API] Warning: could not fetch created assignment", e.message);
  }
  if (deriveScheduledDate && !scheduledDate) {
    const rows = await sf.query(
      `SELECT ${o2.assignmentDate} FROM ${o2.assignment}
       WHERE ${o2.assignmentOppLookup} = '${esc(oppId)}'
         AND ${o2.assignmentDate} != null`
    );
    const dates = rows.map((r) => r[o2.assignmentDate]).filter(Boolean).sort();
    scheduledDate = dates[0] ?? workDate ?? null;
  }
  const fsDebug = { techName: assignmentRec?.technicianName ?? null, fsUserId: null, fsTaskId: null, patch: null, error: null };
  if (assignmentRec?.technicianName && oppId !== env.TIME_OFF_OPPORTUNITY_ID) {
    const fsUserId = fsUserByTechName[assignmentRec.technicianName];
    fsDebug.fsUserId = fsUserId ?? `NOT IN MAP (name="${assignmentRec.technicianName}")`;
    if (fsUserId) {
      let fsTaskId = null;
      try {
        const fs = createFs(env);
        const opps = await sf.query(
          `SELECT ${f2.oppFsTaskId}, ${f2.oppScheduledDate}
           FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1`
        );
        fsTaskId = opps[0]?.[f2.oppFsTaskId];
        fsDebug.fsTaskId = fsTaskId ?? "NULL (not linked)";
        if (fsTaskId) {
          const task = await fs.getTask(fsTaskId);
          const toId = /* @__PURE__ */ __name((u) => typeof u === "string" ? u : u?.ObjectId ?? null, "toId");
          const currentUserIds = (Array.isArray(task.Users) ? task.Users : []).map(toId).filter(Boolean);
          const fsPatch = {};
          if (!currentUserIds.includes(fsUserId)) {
            fsPatch.Users = [...currentUserIds, fsUserId];
          }
          if (status) {
            const fsStatus = sfToFsStatus(status, true);
            if (fsStatus) fsPatch.Status = fsStatus;
          }
          const assignDate = scheduledDate ?? workDate ?? opps[0]?.[f2.oppScheduledDate];
          if (assignDate) {
            const sched = buildFsSchedules(task, assignDate, startTime || "08:00");
            if (sched) fsPatch.Schedules = sched;
          }
          fsDebug.patch = Object.keys(fsPatch);
          if (Object.keys(fsPatch).length > 0) {
            await fs.patchTask(fsTaskId, task, fsPatch);
          }
        }
      } catch (fsErr) {
        console.error("[routes] FS assign failed (SF kept):", fsErr.message, { fsTaskId });
        fsDebug.error = fsErr.message;
      }
    }
  }
  if (status != null || scheduledDate != null) {
    try {
      const oppPayload = {};
      if (status != null) oppPayload[f2.oppStatus] = status || null;
      if (scheduledDate != null) oppPayload[f2.oppScheduledDate] = scheduledDate === "" ? null : scheduledDate;
      if (Object.keys(oppPayload).length > 0) await sf.updateRecord("Opportunity", oppId, oppPayload);
    } catch (oppErr) {
      console.error("[routes] SF Opp update failed (assignment kept):", oppErr.message);
    }
  }
  return { assignmentId: createdId, assignment: assignmentRec, fsDebug };
}
__name(createAssignment, "createAssignment");

// server/src/scheduleRequests.js
var sr = config.scheduleRequest;
var OPEN_STATUSES = ["Requested", "Countered"];
function shapeRequest(r, env) {
  return {
    id: r.Id,
    jobId: r[sr.job] ?? null,
    jobName: r[sr.jobRelationship]?.Name ?? null,
    type: r[sr.type] ?? null,
    technicianId: r[sr.tech] ?? null,
    technicianName: r[sr.techRelationship]?.Name ?? null,
    requestedById: r[sr.requestedBy] ?? null,
    requestedByName: r[sr.requestedByRelationship]?.Name ?? null,
    proposedDate: r[sr.proposedDate] ?? null,
    proposedStart: normTime(r[sr.proposedStart]),
    proposedEnd: normTime(r[sr.proposedEnd]),
    status: r[sr.status],
    lastOfferBy: r[sr.lastOfferBy] ?? null,
    note: r[sr.note] ?? null,
    officeNote: r[sr.officeNote] ?? null,
    createdDate: r.CreatedDate ?? null,
    // Derived fields the requests panel needs.
    waitingOn: r[sr.lastOfferBy] === "Office" ? "tech" : "office",
    isTimeOff: r[sr.type] === "Time off",
    isNewWo: r[sr.job] === env.NEW_WO_OPPORTUNITY_ID,
    ageHours: r.CreatedDate ? (Date.now() - new Date(r.CreatedDate).getTime()) / 36e5 : null
  };
}
__name(shapeRequest, "shapeRequest");
var scheduleRequests = new Hono2();
scheduleRequests.get("/schedule-requests", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const soql = `
      SELECT Id, ${sr.job}, ${sr.jobRelationship}.Name, ${sr.type},
             ${sr.tech}, ${sr.techRelationship}.Name,
             ${sr.requestedBy}, ${sr.requestedByRelationship}.Name,
             ${sr.proposedDate}, ${sr.proposedStart}, ${sr.proposedEnd},
             ${sr.status}, ${sr.lastOfferBy}, ${sr.note}, ${sr.officeNote}, CreatedDate
      FROM ${sr.sobject}
      WHERE ${sr.status} IN ('${OPEN_STATUSES.join("','")}')
      ORDER BY CreatedDate ASC`;
    const records = await sf.query(soql);
    return c.json(records.map((r) => shapeRequest(r, c.env)));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
scheduleRequests.post("/schedule-requests/:id/approve", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param("id");
    const { opportunityId } = await c.req.json().catch(() => ({}));
    const rows = await sf.query(
      `SELECT Id, ${sr.job}, ${sr.type}, ${sr.tech}, ${sr.proposedDate}, ${sr.proposedStart},
              ${sr.status}, ${sr.lastOfferBy}
       FROM ${sr.sobject} WHERE Id = '${esc(id)}' LIMIT 1`
    );
    const reqRec = rows[0];
    if (!reqRec) return c.json({ error: "Schedule request not found" }, 404);
    if (!OPEN_STATUSES.includes(reqRec[sr.status])) {
      return c.json({ error: `Cannot approve a request in status "${reqRec[sr.status]}"` }, 409);
    }
    if (reqRec[sr.lastOfferBy] === "Office") {
      return c.json({ error: "Cannot approve \u2014 waiting on technician response" }, 409);
    }
    let targetOppId = reqRec[sr.job];
    if (targetOppId === c.env.NEW_WO_OPPORTUNITY_ID && !opportunityId) {
      return c.json({ error: 'opportunityId required to approve a "New WO Required" request' }, 400);
    }
    if (opportunityId) {
      await sf.updateRecord(sr.sobject, id, { [sr.job]: opportunityId });
      targetOppId = opportunityId;
    }
    const { assignmentId } = await createAssignment(c.env, targetOppId, {
      technicianId: reqRec[sr.tech],
      workDate: reqRec[sr.proposedDate],
      startTime: normTime(reqRec[sr.proposedStart]),
      status: "Scheduled",
      deriveScheduledDate: true
    });
    await sf.updateRecord(sr.sobject, id, {
      [sr.status]: "Approved",
      [sr.resultingAssignment]: assignmentId,
      [sr.resolvedAt]: (/* @__PURE__ */ new Date()).toISOString()
    });
    return c.json({ ok: true, assignmentId, opportunityId: targetOppId });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
scheduleRequests.post("/schedule-requests/:id/counter", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param("id");
    const { date, start, end, officeNote } = await c.req.json();
    const rows = await sf.query(
      `SELECT Id, ${sr.status}, ${sr.lastOfferBy} FROM ${sr.sobject} WHERE Id = '${esc(id)}' LIMIT 1`
    );
    const reqRec = rows[0];
    if (!reqRec) return c.json({ error: "Schedule request not found" }, 404);
    if (!OPEN_STATUSES.includes(reqRec[sr.status])) {
      return c.json({ error: `Cannot counter a request in status "${reqRec[sr.status]}"` }, 409);
    }
    if (reqRec[sr.lastOfferBy] === "Office") {
      return c.json({ error: "Cannot counter \u2014 waiting on technician response" }, 409);
    }
    const payload = {
      [sr.proposedDate]: date,
      [sr.proposedStart]: toSfTime(start),
      [sr.proposedEnd]: toSfTime(end),
      [sr.status]: "Countered",
      [sr.lastOfferBy]: "Office"
    };
    if (officeNote) payload[sr.officeNote] = officeNote;
    await sf.updateRecord(sr.sobject, id, payload);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
scheduleRequests.post("/schedule-requests/:id/deny", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param("id");
    const { officeNote } = await c.req.json();
    if (!officeNote) return c.json({ error: "officeNote required" }, 400);
    const rows = await sf.query(
      `SELECT Id, ${sr.status} FROM ${sr.sobject} WHERE Id = '${esc(id)}' LIMIT 1`
    );
    const reqRec = rows[0];
    if (!reqRec) return c.json({ error: "Schedule request not found" }, 404);
    if (!OPEN_STATUSES.includes(reqRec[sr.status])) {
      return c.json({ error: `Cannot deny a request in status "${reqRec[sr.status]}"` }, 409);
    }
    await sf.updateRecord(sr.sobject, id, {
      [sr.status]: "Denied",
      [sr.officeNote]: officeNote,
      [sr.resolvedAt]: (/* @__PURE__ */ new Date()).toISOString()
    });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// server/src/routes.js
var f3 = config.fields;
var o3 = config.objects;
var FS_TASK_TYPE = "CCTV Job/Work Order";
function shapeJob(r) {
  const child = r[o3.assignmentChildRelationship];
  const assignments = child ? child.records.map((a) => ({
    assignmentId: a.Id,
    technicianId: a[o3.assignmentTechLookup],
    technicianName: a[o3.assignmentTechRelationship]?.Name ?? null,
    workDate: a[o3.assignmentDate] ?? null,
    startTime: normTime(a[o3.assignmentStartTime]) || "07:00",
    completed: a[o3.assignmentCompleted] === true
  })) : [];
  const address = [r[f3.addrStreet], r[f3.addrCity], r[f3.addrState], r[f3.addrZip]].filter(Boolean).join(", ");
  return {
    id: r.Id,
    name: r[f3.oppName],
    lid: r[f3.oppLid] ?? null,
    status: r[f3.oppStatus],
    scheduledDate: r[f3.oppScheduledDate] ?? null,
    createdDate: r.CreatedDate ?? null,
    closeDate: r.CloseDate ?? null,
    address,
    assignments,
    // FS integration fields
    fsTaskId: r[f3.oppFsTaskId] ?? null,
    // Raw FS status snapshot — written only by the FS sync path (fsSync.js,
    // fs-link). Never normalized, never touched by the dispatch-status write
    // path. Used purely for the drift badge, not for board filtering/logic.
    fsStatus: r[f3.oppFsStatus] ?? null,
    fsLastModified: r[f3.oppFsLastModified] ?? null,
    opportunityType: r[f3.oppType] ?? null
  };
}
__name(shapeJob, "shapeJob");
var api = new Hono2();
api.route("/", scheduleRequests);
api.get("/jobs", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const statusParam = c.req.query("status");
    const statuses = statusParam ? [statusParam] : config.jobStatusValues;
    const inList = statuses.map((s) => `'${esc(s)}'`).join(",");
    const sinceClause = statusParam ? "" : `AND (CloseDate >= LAST_N_DAYS:365 OR CloseDate > TODAY)`;
    const excludeClause = `AND (${f3.oppType} != 'Monitoring' OR ${f3.oppType} = null)`;
    const soql = `
      SELECT Id, ${f3.oppName}, ${f3.oppLid}, ${f3.oppStatus}, ${f3.oppScheduledDate},
             ${f3.oppFsTaskId}, ${f3.oppFsStatus}, ${f3.oppFsLastModified}, ${f3.oppType}, CreatedDate, CloseDate,
             ${f3.addrStreet}, ${f3.addrCity}, ${f3.addrState}, ${f3.addrZip},
             (SELECT Id, ${o3.assignmentTechLookup}, ${o3.assignmentTechRelationship}.Name,
                     ${o3.assignmentDate}, ${o3.assignmentStartTime}, ${o3.assignmentCompleted}
              FROM ${o3.assignmentChildRelationship})
      FROM Opportunity
      WHERE ${f3.oppStatus} IN (${inList})
      ${sinceClause}
      ${excludeClause}
      ORDER BY ${f3.oppScheduledDate} ASC NULLS LAST`;
    const records = await sf.query(soql);
    return c.json(records.map(shapeJob));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.get("/technicians", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const soql = `SELECT Id, Name FROM ${o3.technician}
                  WHERE ${o3.technicianActive} = true ORDER BY Name`;
    const recs = await sf.query(soql);
    return c.json(recs.map((t) => ({ id: t.Id, name: t.Name })));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.get("/time-off", async (c) => {
  try {
    const start = c.req.query("start");
    const end = c.req.query("end");
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    if (!start || !end || !isoDate.test(start) || !isoDate.test(end)) {
      return c.json({ error: "start and end are required, as YYYY-MM-DD" }, 400);
    }
    const sf = createSalesforce(c.env);
    const soql = `
      SELECT Id, ${o3.assignmentTechLookup}, ${o3.assignmentTechRelationship}.Name,
             ${o3.assignmentDate}, ${o3.assignmentStartTime}
      FROM ${o3.assignment}
      WHERE ${o3.assignmentOppLookup} = '${esc(c.env.TIME_OFF_OPPORTUNITY_ID)}'
        AND ${o3.assignmentDate} >= ${start} AND ${o3.assignmentDate} <= ${end}`;
    const records = await sf.query(soql);
    return c.json(records.map((r) => ({
      id: r.Id,
      technicianId: r[o3.assignmentTechLookup],
      technicianName: r[o3.assignmentTechRelationship]?.Name ?? null,
      workDate: r[o3.assignmentDate] ?? null,
      startTime: normTime(r[o3.assignmentStartTime])
    })));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.patch("/jobs/:id", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const fs = createFs(c.env);
    const id = c.req.param("id");
    const body = await c.req.json();
    const suppressRelease = !!body._suppressRelease;
    const allowed = { scheduledDate: f3.oppScheduledDate, status: f3.oppStatus };
    const payload = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowed[key]) payload[allowed[key]] = value === "" ? null : value;
    }
    if (Object.keys(payload).length === 0) {
      return c.json({ error: "No writable fields in request" }, 400);
    }
    let previousSfStatus = null;
    let fsTaskId = null;
    let shouldReleaseCrew = false;
    let oppName = "";
    if ("scheduledDate" in body || "status" in body) {
      const existing = await sf.query(
        `SELECT ${f3.oppName}, ${f3.oppScheduledDate}, ${f3.oppStatus}, ${f3.oppFsTaskId}
         FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`
      );
      const cur = existing?.[0];
      oppName = cur?.[f3.oppName] ?? "";
      if ("scheduledDate" in body) {
        const curVal = cur?.[f3.oppScheduledDate] ?? null;
        const newVal = body.scheduledDate === "" ? null : body.scheduledDate;
        if (curVal !== newVal) shouldReleaseCrew = true;
      }
      if ("status" in body) previousSfStatus = cur?.[f3.oppStatus] ?? null;
      fsTaskId = cur?.[f3.oppFsTaskId] ?? null;
    }
    await sf.updateRecord("Opportunity", id, payload);
    if (shouldReleaseCrew && !suppressRelease) {
      const rows = await sf.query(
        `SELECT Id FROM ${o3.assignment}
         WHERE ${o3.assignmentOppLookup} = '${esc(id)}' AND ${o3.assignmentCompleted} = false`
      );
      await Promise.all(rows.map(
        (r) => sf.updateRecord(o3.assignment, r.Id, { [o3.assignmentDate]: null })
      ));
    }
    let fsUpdated = false;
    let fsError = null;
    const hasDateChange = "scheduledDate" in body;
    if (fsTaskId && ("status" in body || hasDateChange)) {
      try {
        let fsStatus = null;
        if ("status" in body) {
          let hasAssignments = false;
          if (body.status === "Scheduled") {
            const check = await sf.query(
              `SELECT Id FROM ${o3.assignment} WHERE ${o3.assignmentOppLookup} = '${esc(id)}' LIMIT 1`
            );
            hasAssignments = check.length > 0;
          }
          fsStatus = sfToFsStatus(body.status, hasAssignments);
        }
        if (!hasDateChange && fsStatus) {
          await fs.updateStatus(fsTaskId, oppName, FS_TASK_TYPE, fsStatus);
          fsUpdated = true;
        } else if (hasDateChange) {
          let assignTime = "08:00";
          if (body.scheduledDate) {
            try {
              const asgn = await sf.query(
                `SELECT ${o3.assignmentStartTime} FROM ${o3.assignment}
                 WHERE ${o3.assignmentOppLookup} = '${esc(id)}'
                   AND ${o3.assignmentCompleted} = false
                   AND ${o3.assignmentDate} != null
                 ORDER BY ${o3.assignmentDate} ASC NULLS LAST LIMIT 1`
              );
              if (asgn[0]?.[o3.assignmentStartTime]) assignTime = asgn[0][o3.assignmentStartTime];
            } catch (_) {
            }
          }
          const task = await fs.getTask(fsTaskId);
          const sched = body.scheduledDate ? buildFsSchedules(task, body.scheduledDate, assignTime) : [];
          const fsPatch = {};
          if (fsStatus) fsPatch.Status = fsStatus;
          fsPatch.Schedules = sched;
          await fs.patchTask(fsTaskId, task, fsPatch);
          if (fsStatus) fsUpdated = true;
        }
      } catch (fsErr) {
        console.error("[routes] FS write failed (SF kept):", fsErr.message);
        fsError = fsErr.message;
      }
    }
    return c.json({ ok: true, fsUpdated, fsError });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.post("/jobs/:oppId/assignments", async (c) => {
  try {
    const oppId = c.req.param("oppId");
    const { technicianId, workDate, startTime, status, scheduledDate, deriveScheduledDate } = await c.req.json();
    if (!technicianId) return c.json({ error: "technicianId required" }, 400);
    const result = await createAssignment(c.env, oppId, {
      technicianId,
      workDate,
      startTime,
      status,
      scheduledDate,
      deriveScheduledDate
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.patch("/assignments/:id", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param("id");
    const body = await c.req.json();
    const fields = {};
    if (typeof body.completed === "boolean") fields[o3.assignmentCompleted] = body.completed;
    if ("workDate" in body) fields[o3.assignmentDate] = body.workDate === "" ? null : body.workDate;
    if ("startTime" in body) fields[o3.assignmentStartTime] = toSfTime(body.startTime || "07:00");
    if (Object.keys(fields).length === 0) return c.json({ error: "Nothing to update" }, 400);
    let oppId = null;
    let workDateForFs = null;
    let startTimeForFs = null;
    const needsFsSync = "workDate" in body || "startTime" in body;
    if (needsFsSync) {
      try {
        const rows = await sf.query(
          `SELECT ${o3.assignmentOppLookup}, ${o3.assignmentDate}, ${o3.assignmentStartTime}
           FROM ${o3.assignment} WHERE Id = '${esc(id)}' LIMIT 1`
        );
        if (rows[0]) {
          oppId = rows[0][o3.assignmentOppLookup];
          workDateForFs = "workDate" in body ? body.workDate || null : rows[0][o3.assignmentDate] ?? null;
          startTimeForFs = "startTime" in body ? body.startTime || "07:00" : normTime(rows[0][o3.assignmentStartTime]) || "07:00";
        }
      } catch (e) {
        console.warn("[routes] Could not pre-fetch assignment for FS sync:", e.message);
      }
    }
    await sf.updateRecord(o3.assignment, id, fields);
    if (oppId && needsFsSync) {
      try {
        const fs = createFs(c.env);
        const opps = await sf.query(
          `SELECT ${f3.oppFsTaskId} FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1`
        );
        const fsTaskId = opps[0]?.[f3.oppFsTaskId];
        if (fsTaskId) {
          const task = await fs.getTask(fsTaskId);
          let sched;
          if (workDateForFs) {
            sched = buildFsSchedules(task, workDateForFs, startTimeForFs);
          } else {
            const remaining = await sf.query(
              `SELECT ${o3.assignmentDate}, ${o3.assignmentStartTime}, ${o3.assignmentCompleted}
               FROM ${o3.assignment} WHERE ${o3.assignmentOppLookup} = '${esc(oppId)}'`
            );
            const next = remaining.filter((a) => a[o3.assignmentDate] && !a[o3.assignmentCompleted]).sort((a, b) => {
              const d = String(a[o3.assignmentDate]).localeCompare(String(b[o3.assignmentDate]));
              return d !== 0 ? d : (normTime(a[o3.assignmentStartTime]) || "").localeCompare(normTime(b[o3.assignmentStartTime]) || "");
            })[0];
            sched = next ? buildFsSchedules(task, next[o3.assignmentDate], normTime(next[o3.assignmentStartTime]) || "08:00") : [];
          }
          if (sched !== null) await fs.patchTask(fsTaskId, task, { Schedules: sched });
        }
      } catch (fsErr) {
        console.error("[routes] FS schedule patch failed (SF kept):", fsErr.message);
      }
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.delete("/assignments/:id", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param("id");
    let techName = null;
    let techId = null;
    let oppId = null;
    try {
      const rows = await sf.query(
        `SELECT ${o3.assignmentOppLookup}, ${o3.assignmentTechLookup}, ${o3.assignmentTechRelationship}.Name
         FROM ${o3.assignment} WHERE Id = '${esc(id)}' LIMIT 1`
      );
      if (rows[0]) {
        techName = rows[0][o3.assignmentTechRelationship]?.Name ?? null;
        techId = rows[0][o3.assignmentTechLookup] ?? null;
        oppId = rows[0][o3.assignmentOppLookup] ?? null;
      }
    } catch (e) {
      console.warn("[routes] Could not pre-fetch assignment for FS sync:", e.message);
    }
    await sf.deleteRecord(o3.assignment, id);
    const fsUserId = techName ? fsUserByTechName[techName] : null;
    if (fsUserId && oppId) {
      try {
        const fs = createFs(c.env);
        const opps = await sf.query(
          `SELECT ${f3.oppFsTaskId} FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1`
        );
        const fsTaskId = opps[0]?.[f3.oppFsTaskId];
        if (fsTaskId) {
          const task = await fs.getTask(fsTaskId);
          const toId = /* @__PURE__ */ __name((u) => typeof u === "string" ? u : u?.ObjectId ?? null, "toId");
          const remaining = await sf.query(
            `SELECT ${o3.assignmentDate}, ${o3.assignmentStartTime}, ${o3.assignmentCompleted},
                    ${o3.assignmentTechLookup}
             FROM ${o3.assignment} WHERE ${o3.assignmentOppLookup} = '${esc(oppId)}'`
          );
          const techStillAssigned = remaining.some((a) => a[o3.assignmentTechLookup] === techId);
          const updatedUsers = (Array.isArray(task.Users) ? task.Users : []).map(toId).filter((uid) => uid && (uid !== fsUserId || techStillAssigned));
          const next = remaining.filter((a) => a[o3.assignmentDate] && !a[o3.assignmentCompleted]).sort((a, b) => {
            const d = String(a[o3.assignmentDate]).localeCompare(String(b[o3.assignmentDate]));
            return d !== 0 ? d : (normTime(a[o3.assignmentStartTime]) || "").localeCompare(normTime(b[o3.assignmentStartTime]) || "");
          })[0];
          const patch = { Users: updatedUsers };
          if (next) {
            const time = normTime(next[o3.assignmentStartTime]) || "08:00";
            patch.Schedules = buildFsSchedules(task, next[o3.assignmentDate], time);
          } else {
            patch.Schedules = [];
          }
          await fs.patchTask(fsTaskId, task, patch);
        }
      } catch (fsErr) {
        console.error("[routes] FS unassign failed (SF kept):", fsErr.message);
      }
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.get("/fs-search", async (c) => {
  try {
    const q = c.req.query("q")?.trim();
    if (!q || q.length < 3) return c.json({ error: "Query must be at least 3 characters" }, 400);
    const fs = createFs(c.env);
    const KV = c.env.SF_TOKENS;
    const CACHE_KEY = "fs_task_list_v2";
    const CACHE_TTL = 600;
    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1e3).toISOString();
    const lower = q.toLowerCase();
    const filterTasks = /* @__PURE__ */ __name((tasks2) => tasks2.filter((t) => t.Name && t.Name.toLowerCase().includes(lower)).slice(0, 15).map((t) => ({ externalId: t.ExternalId, name: t.Name, status: t.Status, taskType: t.TaskType })), "filterTasks");
    async function fetchAndCache() {
      const tasks2 = await fs.listModified(since);
      if (KV) await KV.put(CACHE_KEY, JSON.stringify(tasks2), { expirationTtl: CACHE_TTL });
      return tasks2;
    }
    __name(fetchAndCache, "fetchAndCache");
    let fromCache = false;
    let tasks = null;
    if (KV) {
      const cached = await KV.get(CACHE_KEY, "json");
      if (cached) {
        tasks = cached;
        fromCache = true;
      }
    }
    if (!tasks) tasks = await fetchAndCache();
    let matches = filterTasks(tasks);
    if (matches.length === 0 && fromCache) {
      const todaySince = new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
      const recent = await fs.listModified(todaySince);
      matches = filterTasks(recent);
    }
    return c.json({ matches });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.get("/test/account-fields", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const describe = await sf.raw("/sobjects/Account/describe");
    const fields = describe.fields.map((f4) => ({
      name: f4.name,
      label: f4.label,
      type: f4.type,
      custom: f4.custom
    }));
    return c.json({ total: fields.length, fields });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.get("/test/accounts", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const accounts = await sf.query(`
      SELECT Id, Name, LID__c, Property_Contact_Name__c, Phone, Website, Type, Industry,
             ShippingStreet, ShippingCity, ShippingState, ShippingPostalCode,
             (SELECT Id, Name, FirstName, LastName, Email, Phone, Title FROM Contacts LIMIT 10)
      FROM Account
      LIMIT 5
    `);
    let multiAccountSample = null;
    try {
      multiAccountSample = await sf.query(
        `SELECT Id, AccountId, ContactId, Contact.Name, Account.Name, Account.LID__c
         FROM AccountContactRelation
         LIMIT 5`
      );
    } catch (_) {
      multiAccountSample = "AccountContactRelation not available in this org";
    }
    return c.json({ accounts, multiAccountSample });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.patch("/accounts/:id/contact", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param("id");
    const { contactId } = await c.req.json();
    if (!contactId) return c.json({ error: "contactId required" }, 400);
    await sf.updateRecord("Account", id, {
      Property_Contact_Name__c: contactId
    });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.patch("/contacts/:id", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param("id");
    const body = await c.req.json();
    const fields = {};
    if ("name" in body) {
      const parts = String(body.name || "").trim().split(/\s+/);
      fields.LastName = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
      if (parts.length > 1) fields.FirstName = parts[0];
    }
    if ("email" in body) fields.Email = body.email || null;
    if ("phone" in body) fields.Phone = body.phone || null;
    if (Object.keys(fields).length === 0) return c.json({ error: "Nothing to update" }, 400);
    await sf.updateRecord("Contact", id, fields);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.get("/contacts", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const [contactRecords, accountRecords] = await Promise.all([
      sf.query(`SELECT Id, FirstName, LastName, Name, Email, Phone, Title,
                       AccountId, Account.Name, LastModifiedDate
                FROM Contact ORDER BY LastName, FirstName`),
      sf.query(`SELECT Id, Name, LID__c, Property_Contact_Name__c, ParentId, Parent.Name
                FROM Account WHERE Property_Contact_Name__c != null`)
    ]);
    const accountsByContact = /* @__PURE__ */ new Map();
    for (const a of accountRecords) {
      const contactId = a.Property_Contact_Name__c;
      const arr = accountsByContact.get(contactId) ?? [];
      arr.push({ id: a.Id, name: a.Name, lid: a.LID__c ?? null, parentId: a.ParentId ?? null, parentName: a.Parent?.Name ?? null });
      accountsByContact.set(contactId, arr);
    }
    return c.json(contactRecords.map((r) => ({
      id: r.Id,
      firstName: r.FirstName ?? null,
      lastName: r.LastName ?? null,
      name: r.Name,
      email: r.Email ?? null,
      phone: r.Phone ?? null,
      title: r.Title ?? null,
      company: r.Account?.Name ?? null,
      accounts: accountsByContact.get(r.Id) ?? [],
      lastModifiedDate: r.LastModifiedDate ?? null
    })));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.post("/jobs/:id/fs-link", async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const fs = createFs(c.env);
    const id = c.req.param("id");
    const { fsTaskId } = await c.req.json();
    if (!fsTaskId) return c.json({ error: "fsTaskId required" }, 400);
    await sf.updateRecord("Opportunity", id, { [f3.oppFsTaskId]: fsTaskId });
    const result = { sfStatus: null, assignmentsAdded: 0 };
    try {
      const [oppRows, fullTask, existingAssignments] = await Promise.all([
        sf.query(
          `SELECT ${f3.oppStatus}, ${f3.oppScheduledDate}, LastModifiedDate
           FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`
        ),
        fs.getTask(fsTaskId),
        sf.query(`SELECT ${o3.assignmentTechRelationship}.Name, ${o3.assignmentStartTime} FROM ${o3.assignment} WHERE ${o3.assignmentOppLookup} = '${esc(id)}'`)
      ]);
      const sfOpp = oppRows[0];
      if (!sfOpp) throw new Error("Opp not found");
      await sf.updateRecord("Opportunity", id, {
        [f3.oppFsStatus]: fullTask.Status ?? null,
        [f3.oppFsLastModified]: fullTask.LastUpdated ?? null
      });
      const syncableUserIds = (Array.isArray(fullTask.Users) ? fullTask.Users : []).filter((uid) => uid in config.fsTechUsers);
      const assignedNames = new Set(
        existingAssignments.map((a) => a[o3.assignmentTechRelationship]?.Name).filter(Boolean)
      );
      const willHaveAssignments = existingAssignments.length > 0 || syncableUserIds.length > 0;
      const rec = reconcile(fullTask.Status, sfOpp[f3.oppStatus], fullTask.LastUpdated, sfOpp.LastModifiedDate);
      let targetFsStatus = null;
      if (rec.action === "write") {
        if (rec.target === "sf") {
          await sf.updateRecord("Opportunity", id, { [f3.oppStatus]: rec.value });
          result.sfStatus = rec.value;
        } else {
          targetFsStatus = sfToFsStatus(sfOpp[f3.oppStatus], willHaveAssignments);
        }
      }
      if (fullTask.Status === "Scheduled" && willHaveAssignments) {
        targetFsStatus = "Assigned";
      }
      const fsPatch = {};
      if (targetFsStatus) fsPatch.Status = targetFsStatus;
      if (sfOpp[f3.oppScheduledDate]) {
        const firstTime = existingAssignments[0]?.[o3.assignmentStartTime] ?? "08:00";
        const sched = buildFsSchedules(fullTask, sfOpp[f3.oppScheduledDate], firstTime);
        if (sched) fsPatch.Schedules = sched;
      }
      if (Object.keys(fsPatch).length > 0) {
        await fs.patchTask(fsTaskId, fullTask, fsPatch);
      }
      if (syncableUserIds.length > 0) {
        const sfTechs = await sf.query(
          `SELECT Id, Name FROM ${o3.technician} WHERE ${o3.technicianActive} = true`
        );
        const sfTechIdByName = Object.fromEntries(sfTechs.map((t) => [t.Name, t.Id]));
        for (const fsUserId of syncableUserIds) {
          const techName = config.fsTechUsers[fsUserId];
          if (assignedNames.has(techName)) continue;
          const sfTechId = sfTechIdByName[techName];
          if (sfTechId) {
            await sf.createRecord(o3.assignment, {
              [o3.assignmentOppLookup]: id,
              [o3.assignmentTechLookup]: sfTechId,
              [o3.assignmentStartTime]: "07:00:00.000Z"
            });
            result.assignmentsAdded++;
          }
        }
      }
    } catch (recErr) {
      console.error("[routes] fs-link reconcile failed (link still saved):", recErr.message);
    }
    return c.json({ ok: true, fsTaskId, ...result });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
api.get("/debug/documents", async (c) => {
  try {
    const fs = createFs(c.env);
    const externalId = c.req.query("externalId");
    const raw2 = c.req.query("raw");
    const asJson = /* @__PURE__ */ __name((r) => {
      let body = r.body;
      try {
        body = JSON.parse(r.body);
      } catch (_) {
      }
      return { status: r.status, ok: r.ok, errHeader: r.errHeader ?? null, body };
    }, "asJson");
    if (raw2 !== void 0) {
      return c.json({ raw: asJson(await fs.rawDocumentQuery(raw2)) });
    }
    const candidateTypes = [null, "Service Acknowledgement", "Work Order", "Test & Inspection", "Work Order Email - 1"];
    const types = {};
    for (const t of candidateTypes) {
      types[t ?? "(no filter)"] = asJson(await fs.listDocuments(t));
    }
    const result = { types };
    if (externalId) {
      result.document = asJson(await fs.getDocument(externalId));
    }
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// server/src/worker.js
var app = new Hono2();
app.route("/api", api);
var worker_default = {
  // HTTP requests — handled by Hono as before.
  fetch: app.fetch.bind(app),
  // Cron trigger — fires every 5 minutes (configure in wrangler.toml).
  // Runs the FS ↔ SF status reconcile.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFsSync(env));
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-ftMhFp/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-ftMhFp/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
