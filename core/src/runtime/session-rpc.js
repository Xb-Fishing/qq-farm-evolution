const net = require('node:net');
const { EventEmitter } = require('node:events');
const { encode, decode } = require('./session-codec');

const MAX_FRAME = 16 * 1024 * 1024;
function framed(socket, onMessage, codecOptions) {
  let buffered = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME) { socket.destroy(); return; }
      if (buffered.length < length + 4) break;
      const bytes = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      try {
        Promise.resolve(onMessage(decode(bytes, codecOptions))).catch(() => socket.destroy());
      } catch { socket.destroy(); return; }
    }
    if (buffered.length > MAX_FRAME + 4) socket.destroy();
  });
  return value => {
    const bytes = encode(value, codecOptions);
    if (bytes.length > MAX_FRAME) throw new Error('Session message too large');
    const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
    if (socket.destroyed || !socket.writable) throw new Error('Session control disconnected');
    socket.write(Buffer.concat([header, bytes]));
  };
}

class SessionRpcClient extends EventEmitter {
  constructor(descriptor, options = {}) {
    super(); this.descriptor = descriptor; this.options = options;
    this.pending = new Map(); this.sequence = 0; this.ready = false;
  }
  async connect() {
    const socket = net.createConnection(this.descriptor.socketPath);
    this.socket = socket;
    this.write = framed(socket, message => {
      if (message.kind === 'event') { this.emit('event', message.message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(message.error instanceof Error ? message.error : new Error('Session request rejected'));
      else pending.resolve(message.value);
    }, this.options.codec);
    socket.on('error', () => {});
    socket.on('close', () => {
      this.ready = false;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Session control disconnected')); }
      this.pending.clear(); this.emit('disconnect');
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Session connect timed out')); }, 5000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('Session connect failed')); });
    });
    const hello = await this.call('hello', { capability: this.descriptor.capability, hostId: this.descriptor.hostId });
    if (hello.hostId !== this.descriptor.hostId || hello.pid !== this.descriptor.pid
      || hello.starttime !== this.descriptor.starttime || hello.contractVersion !== this.descriptor.contractVersion
      || hello.sourceRoot !== this.descriptor.sourceRoot || hello.sourceCommit !== this.descriptor.sourceCommit
      || hello.sourceFingerprint !== this.descriptor.sourceFingerprint) { socket.destroy(); throw new Error('Session identity changed'); }
    this.ready = true;
    return hello;
  }
  call(method, args = {}, timeoutMs = 180000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Session control request timed out')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ kind: 'request', id, method, args }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { this.socket?.destroy(); }
}
module.exports = { framed, SessionRpcClient, MAX_FRAME };
