"use strict";

const fs = require("fs").promises;
const path = require("path");
const string_decoder = require("string_decoder");
const util = require("util");
const vm = require("vm");
const worker_threads = require("worker_threads");

class JSValContext {
  constructor() {
    this.jsvalMap = new Map();
    this.jsvalLast = 0n;
    Object.seal(this);
  }

  new(x) {
    const i = this.jsvalLast++;
    this.jsvalMap.set(i, x);
    return i;
  }

  get(i) {
    if (!this.jsvalMap.has(i)) {
      throw new Error(`jsval.get(${i}): invalid key`);
    }
    return this.jsvalMap.get(i);
  }

  free(i) {
    if (!this.jsvalMap.delete(i)) {
      throw new Error(`jsval.free(${i}): invalid key`);
    }
  }

  clear() {
    this.jsvalMap.clear();
    this.jsvalLast = 0n;
  }
}

class MainContext {
  constructor() {
    process.on("uncaughtException", (err) => this.onUncaughtException(err));
    this.worker = new worker_threads.Worker(__filename, { stdout: true });
    this.worker.on("message", (buf_msg) => this.onWorkerMessage(buf_msg));
    this.recvLoop();
    Object.freeze(this);
  }
  recvLoop() {
    let buf = Buffer.allocUnsafe(0);
    process.stdin.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      while (true) {
        if (buf.length < 8) return;
        const len = Number(buf.readBigUInt64LE(0));
        if (buf.length < 8 + len) return;
        const buf_msg = buf.slice(8, 8 + len);
        buf = buf.slice(8 + len);
        if (msgIsClose(buf_msg)) {
          process.stdin.unref();
        }
        this.worker.postMessage(buf_msg);
      }
    });
  }
  send(buf_msg) {
    return new Promise((resolve, reject) => {
      const buf_send = Buffer.allocUnsafe(8 + buf_msg.length);
      buf_send.writeBigUInt64LE(BigInt(buf_msg.length));
      buf_msg.copy(buf_send, 8);
      process.stdout.write(buf_send, (err) => (err ? reject(err) : resolve()));
    });
  }
  onWorkerMessage(buf_msg) {
    this.send(bufferFromArrayBufferView(buf_msg));
  }
  async onUncaughtException(err) {
    const err_str = `${err.stack ? err.stack : err}`;
    const err_buf = Buffer.from(err_str, "utf-8");
    const resp_buf = Buffer.allocUnsafe(9 + err_buf.length);
    resp_buf.writeUInt8(1, 0);
    resp_buf.writeBigUInt64LE(BigInt(err_buf.length), 1);
    err_buf.copy(resp_buf, 9);
    await this.send(resp_buf);
    process.exit(1);
  }
}

class WorkerContext {
  constructor() {
    this.decoder = new string_decoder.StringDecoder("utf-8");
    this.jsval = new JSValContext();
    (async () => {
      if (process.env.INLINE_JS_NODE_MODULES) {
        await fs.symlink(
          process.env.INLINE_JS_NODE_MODULES,
          path.join(__dirname, "node_modules"),
          "dir"
        );
      }
      worker_threads.parentPort.on("message", (buf_msg) =>
        this.onParentMessage(buf_msg)
      );
    })();
    Object.freeze(this);
  }

  toJS(buf, p, async) {
    const jsval_tmp = [];
    const expr_segs_len = Number(buf.readBigUInt64LE(p));
    p += 8;
    let expr = "";
    for (let i = 0; i < expr_segs_len; ++i) {
      const expr_seg_type = buf.readUInt8(p);
      p += 1;
      switch (expr_seg_type) {
        case 0: {
          // Code
          const expr_seg_len = Number(buf.readBigUInt64LE(p));
          p += 8;
          expr = `${expr}${this.decoder.end(buf.slice(p, p + expr_seg_len))}`;
          p += expr_seg_len;
          break;
        }
        case 1: {
          // BufferLiteral
          const buf_len = Number(buf.readBigUInt64LE(p));
          p += 8;
          const buf_id = jsval_tmp.push(buf.slice(p, p + buf_len)) - 1;
          expr = `${expr}__t${buf_id.toString(36)}`;
          p += buf_len;
          break;
        }
        case 2: {
          // StringLiteral
          const buf_len = Number(buf.readBigUInt64LE(p));
          p += 8;
          const str_id =
            jsval_tmp.push(this.decoder.end(buf.slice(p, p + buf_len))) - 1;
          expr = `${expr}__t${str_id.toString(36)}`;
          p += buf_len;
          break;
        }
        case 3: {
          // JSONLiteral
          const buf_len = Number(buf.readBigUInt64LE(p));
          p += 8;
          const json_id =
            jsval_tmp.push(
              JSON.parse(this.decoder.end(buf.slice(p, p + buf_len)))
            ) - 1;
          expr = `${expr}__t${json_id.toString(36)}`;
          p += buf_len;
          break;
        }
        case 4: {
          // JSValLiteral
          const jsval_id =
            jsval_tmp.push(this.jsval.get(buf.readBigUInt64LE(p))) - 1;
          expr = `${expr}__t${jsval_id.toString(36)}`;
          p += 8;
          break;
        }
        default: {
          throw new Error(`toJS failed: ${buf}`);
        }
      }
    }

    let expr_params = "require";
    for (let i = 0; i < jsval_tmp.length; ++i) {
      expr_params = `${expr_params}, __t${i.toString(36)}`;
    }
    expr = `${async ? "async " : ""}(${expr_params}) => (\n${expr}\n)`;
    const result = vm.runInThisContext(expr, {
      lineOffset: -1,
      importModuleDynamically: (spec) => import(spec),
    })(require, ...jsval_tmp);

    return { p: p, result: result };
  }

  fromJS(val, val_type) {
    switch (val_type) {
      case 0: {
        // RawNone
        return Buffer.allocUnsafe(0);
      }
      case 1: {
        // RawBuffer
        return Buffer.isBuffer(val)
          ? val
          : util.types.isArrayBufferView(val)
          ? bufferFromArrayBufferView(val)
          : Buffer.from(val);
      }
      case 2: {
        // RawJSON
        return Buffer.from(JSON.stringify(val), "utf-8");
      }
      case 3: {
        // RawJSVal
        const val_buf = Buffer.allocUnsafe(8);
        val_buf.writeBigUInt64LE(this.jsval.new(val), 0);
        return val_buf;
      }
      default: {
        throw new Error(`fromJS: invalid type ${val_type}`);
      }
    }
  }

  async onParentMessage(buf_msg) {
    buf_msg = bufferFromArrayBufferView(buf_msg);
    let p = 0;
    const msg_tag = buf_msg.readUInt8(p);
    p += 1;
    switch (msg_tag) {
      case 0: {
        // JSEvalRequest
        let resp_buf;
        const req_id = buf_msg.readBigUInt64LE(p);
        p += 8;
        try {
          const r = this.toJS(buf_msg, p, true);
          p = r.p;
          const eval_result = await r.result;

          const return_type = buf_msg.readUInt8(p);
          p += 1;
          const eval_result_buf = this.fromJS(eval_result, return_type);
          resp_buf = Buffer.allocUnsafe(18 + eval_result_buf.length);
          resp_buf.writeUInt8(0, 0);
          resp_buf.writeBigUInt64LE(req_id, 1);
          resp_buf.writeUInt8(1, 9);
          resp_buf.writeBigUInt64LE(BigInt(eval_result_buf.length), 10);
          eval_result_buf.copy(resp_buf, 18);
        } catch (err) {
          // EvalError
          const err_str = `${err.stack ? err.stack : err}`;
          if (process.env.INLINE_JS_EXIT_ON_EVAL_ERROR) {
            process.stderr.write(
              `inline-js eval error, exiting node: ${err_str}\n`,
              () => {
                process.kill(process.pid, "SIGTERM");
              }
            );
          }
          const err_buf = Buffer.from(err_str, "utf-8");
          resp_buf = Buffer.allocUnsafe(18 + err_buf.length);
          resp_buf.writeUInt8(0, 0);
          resp_buf.writeBigUInt64LE(req_id, 1);
          resp_buf.writeUInt8(0, 9);
          resp_buf.writeBigUInt64LE(BigInt(err_buf.length), 10);
          err_buf.copy(resp_buf, 18);
        }
        worker_threads.parentPort.postMessage(resp_buf);
        break;
      }
      case 1: {
        // JSValFree
        const jsval_id = buf_msg.readBigUInt64LE(p);
        p += 8;
        this.jsval.free(jsval_id);
        break;
      }
      case 2: {
        // Close
        this.jsval.clear();
        worker_threads.parentPort.unref();
        break;
      }
      default: {
        throw new Error(`recv: invalid message ${buf_msg}`);
      }
    }
  }
}

function msgIsClose(buf_msg) {
  return buf_msg.readUInt8(0) === 2;
}

function bufferFromArrayBufferView(a) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

if (worker_threads.isMainThread) {
  new MainContext();
} else {
  new WorkerContext();
}