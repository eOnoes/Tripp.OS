/**
 * @tripp-os/agent-communication
 *
 * HTTP-based agent communication layer built on top of the agent-bus.
 * Provides message passing between agents and execution tracing.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_PORT = 4320;
const MESSAGE_STORE_PATH = process.env.TRIPP_OS_MESSAGES || path.join(process.cwd(), 'messages');
const TRACE_STORE_PATH = process.env.TRIPP_OS_TRACES || path.join(process.cwd(), 'traces');

// ── Message Types ──────────────────────────────────────────────────────

/**
 * @typedef {Object} AgentMessage
 * @property {string} messageId
 * @property {string} from - Sender agent ID
 * @property {string} to - Recipient agent ID or 'broadcast'
 * @property {string} type - Message type (task, result, heartbeat, command, event)
 * @property {string} subject
 * @property {Object} payload
 * @property {string} timestamp
 * @property {string} [replyTo] - Original message ID if this is a reply
 */

// ── Execution Trace ───────────────────────────────────────────────────

/**
 * @typedef {Object} ExecutionTrace
 * @property {string} traceId
 * @property {string} agentId
 * @property {string} taskId
 * @property {string} action
 * @property {string} status - started, completed, failed
 * @property {Object} [result]
 * @property {string} [error]
 * @property {string} startTime
 * @property {string} [endTime]
 * @property {number} [durationMs]
 */

// ── Message Store ──────────────────────────────────────────────────────

class MessageStore {
  constructor(storePath) {
    this.storePath = storePath;
    this.queues = new Map(); // agentId -> messages[]
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await fs.mkdir(this.storePath, { recursive: true });
    
    // Load any existing messages
    try {
      const files = await fs.readdir(this.storePath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = await fs.readFile(path.join(this.storePath, file), 'utf-8');
          const message = JSON.parse(content);
          this.enqueue(message);
        }
      }
    } catch {
      // Empty store is fine
    }
    
    this.initialized = true;
  }

  generateMessageId() {
    const hash = createHash('sha256')
      .update(`${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 12);
    return `msg-${hash}`;
  }

  enqueue(message) {
    const target = message.to || 'broadcast';
    if (!this.queues.has(target)) {
      this.queues.set(target, []);
    }
    this.queues.get(target).push(message);
  }

  async persist(message) {
    const filePath = path.join(this.storePath, `${message.messageId}.json`);
    await fs.writeFile(filePath, JSON.stringify(message, null, 2) + '\n', 'utf-8');
  }

  async send(message) {
    await this.init();
    
    const fullMessage = {
      messageId: this.generateMessageId(),
      ...message,
      timestamp: new Date().toISOString(),
      delivered: false
    };

    // Persist to disk
    await this.persist(fullMessage);
    
    // Add to in-memory queue
    this.enqueue(fullMessage);
    
    return fullMessage;
  }

  async receive(agentId) {
    await this.init();
    
    const messages = this.queues.get(agentId) || [];
    const broadcastMessages = this.queues.get('broadcast') || [];
    
    // Combine and sort by timestamp
    const allMessages = [...messages, ...broadcastMessages]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    
    // Mark as delivered
    const delivered = allMessages.map(msg => ({
      ...msg,
      delivered: true
    }));

    // Clear queue
    this.queues.set(agentId, []);
    
    return delivered;
  }

  async getMessages(agentId, { limit = 50, unreadOnly = false } = {}) {
    await this.init();
    
    const messages = this.queues.get(agentId) || [];
    const broadcastMessages = this.queues.get('broadcast') || [];
    
    let allMessages = [...messages, ...broadcastMessages];
    
    if (unreadOnly) {
      allMessages = allMessages.filter(m => !m.delivered);
    }
    
    return allMessages
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }
}

// ── Trace Store ────────────────────────────────────────────────────────

class TraceStore {
  constructor(storePath) {
    this.storePath = storePath;
    this.traces = new Map();
  }

  async init() {
    await fs.mkdir(this.storePath, { recursive: true });
    
    try {
      const files = await fs.readdir(this.storePath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = await fs.readFile(path.join(this.storePath, file), 'utf-8');
          const trace = JSON.parse(content);
          this.traces.set(trace.traceId, trace);
        }
      }
    } catch {
      // Empty store is fine
    }
  }

  generateTraceId() {
    const hash = createHash('sha256')
      .update(`${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 12);
    return `trace-${hash}`;
  }

  async startTrace({ agentId, taskId, action }) {
    await this.init();
    
    const trace = {
      traceId: this.generateTraceId(),
      agentId,
      taskId: taskId || 'unknown',
      action,
      status: 'started',
      startTime: new Date().toISOString(),
      events: []
    };

    this.traces.set(trace.traceId, trace);
    await this.persist(trace);
    
    return trace;
  }

  async completeTrace(traceId, { result, error } = {}) {
    await this.init();
    
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace not found: ${traceId}`);
    }

    trace.endTime = new Date().toISOString();
    trace.durationMs = new Date(trace.endTime) - new Date(trace.startTime);
    trace.status = error ? 'failed' : 'completed';
    
    if (result) trace.result = result;
    if (error) trace.error = error;

    await this.persist(trace);
    
    return trace;
  }

  async addEvent(traceId, event) {
    await this.init();
    
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace not found: ${traceId}`);
    }

    trace.events.push({
      ...event,
      timestamp: new Date().toISOString()
    });

    await this.persist(trace);
    
    return trace;
  }

  async getTrace(traceId) {
    await this.init();
    return this.traces.get(traceId) || null;
  }

  async listTraces({ agentId, limit = 50 } = {}) {
    await this.init();
    
    let traces = Array.from(this.traces.values());
    
    if (agentId) {
      traces = traces.filter(t => t.agentId === agentId);
    }
    
    return traces
      .sort((a, b) => b.startTime.localeCompare(a.startTime))
      .slice(0, limit);
  }

  async persist(trace) {
    const filePath = path.join(this.storePath, `${trace.traceId}.json`);
    await fs.writeFile(filePath, JSON.stringify(trace, null, 2) + '\n', 'utf-8');
  }
}

// ── HTTP Server ────────────────────────────────────────────────────────

export function createAgentCommunicationServer(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const messageStore = new MessageStore(options.messageStorePath || MESSAGE_STORE_PATH);
  const traceStore = new TraceStore(options.traceStorePath || TRACE_STORE_PATH);

  const app = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);
    const agentId = req.headers['x-agent-id'] || 'unknown';

    // ── Health ───────────────────────────────────────────────────────
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK', service: 'agent-communication' }));
      return;
    }

    // ── Messages ─────────────────────────────────────────────────────
    
    // POST /messages - Send a message
    if (url.pathname === '/messages' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const message = await messageStore.send({
          from: agentId,
          to: body.to,
          type: body.type || 'event',
          subject: body.subject || '',
          payload: body.payload || {},
          replyTo: body.replyTo
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'created', message }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // GET /messages/:agentId - Get messages for an agent
    if (url.pathname.startsWith('/messages/') && req.method === 'GET') {
      try {
        const targetAgent = url.pathname.split('/messages/')[1];
        const messages = await messageStore.getMessages(targetAgent);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', messages, count: messages.length }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // POST /messages/:agentId/receive - Agent receives messages
    if (url.pathname.match(/^\/messages\/[^/]+\/receive$/) && req.method === 'POST') {
      try {
        const targetAgent = url.pathname.split('/messages/')[1].split('/receive')[0];
        const messages = await messageStore.receive(targetAgent);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', messages, count: messages.length }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // ── Execution Traces ─────────────────────────────────────────────

    // POST /traces - Start a new trace
    if (url.pathname === '/traces' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const trace = await traceStore.startTrace({
          agentId,
          taskId: body.taskId,
          action: body.action
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'created', trace }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // GET /traces - List traces
    if (url.pathname === '/traces' && req.method === 'GET') {
      try {
        const traces = await traceStore.listTraces({
          agentId: url.searchParams.get('agent_id') || undefined,
          limit: parseInt(url.searchParams.get('limit') || '50')
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', traces, count: traces.length }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // GET /traces/:traceId - Get a specific trace
    if (url.pathname.startsWith('/traces/') && req.method === 'GET') {
      try {
        const traceId = url.pathname.split('/traces/')[1];
        const trace = await traceStore.getTrace(traceId);
        if (!trace) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Trace not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', trace }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // POST /traces/:traceId/complete - Complete a trace
    if (url.pathname.match(/^\/traces\/[^/]+\/complete$/) && req.method === 'POST') {
      try {
        const traceId = url.pathname.split('/traces/')[1].split('/complete')[0];
        const body = await readBody(req);
        const trace = await traceStore.completeTrace(traceId, {
          result: body.result,
          error: body.error
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', trace }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // POST /traces/:traceId/events - Add event to trace
    if (url.pathname.match(/^\/traces\/[^/]+\/events$/) && req.method === 'POST') {
      try {
        const traceId = url.pathname.split('/traces/')[1].split('/events')[0];
        const body = await readBody(req);
        const trace = await traceStore.addEvent(traceId, {
          type: body.type,
          message: body.message,
          data: body.data
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', trace }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // ── 404 ──────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'not_found',
      routes: [
        'GET /health',
        'POST /messages',
        'GET /messages/:agentId',
        'POST /messages/:agentId/receive',
        'POST /traces',
        'GET /traces',
        'GET /traces/:traceId',
        'POST /traces/:traceId/complete',
        'POST /traces/:traceId/events'
      ]
    }));
  });

  return { app, messageStore, traceStore };
}

export function startAgentCommunicationServer(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const { app, messageStore, traceStore } = createAgentCommunicationServer(options);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0');
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      console.log(`Agent Communication running on port ${port}`);
      console.log(`Message store: ${options.messageStorePath || MESSAGE_STORE_PATH}`);
      console.log(`Trace store: ${options.traceStorePath || TRACE_STORE_PATH}`);
      resolve({ server, messageStore, traceStore, port });
    });
  });
}

// ── Helper ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── Client SDK ─────────────────────────────────────────────────────────

export class AgentClient {
  constructor({ baseUrl, agentId }) {
    this.baseUrl = baseUrl;
    this.agentId = agentId;
  }

  async send(to, type, subject, payload) {
    return this.request('POST', '/messages', { to, type, subject, payload });
  }

  async receive() {
    return this.request('POST', `/messages/${this.agentId}/receive`);
  }

  async getMessages() {
    return this.request('GET', `/messages/${this.agentId}`);
  }

  async startTrace(taskId, action) {
    return this.request('POST', '/traces', { taskId, action });
  }

  async completeTrace(traceId, result) {
    return this.request('POST', `/traces/${traceId}/complete`, result);
  }

  async request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Id': this.agentId
        }
      };

      const req = http.request(url, options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}
