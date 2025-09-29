/**
 * Transport layer for communicating with target MCP server
 */

import { spawn, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';

export class TargetServerTransport {
  private process?: ChildProcess;
  private inputStream?: Writable;
  private outputStream?: Readable;
  private messageHandlers: Map<number, (response: any) => void> = new Map();
  private notificationHandlers: ((notification: any) => void)[] = [];
  private nextId = 1;
  private buffer = '';

  constructor(
    private command: string,
    private args: string[]
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
        reject(new Error('Failed to create process pipes'));
        return;
      }

      this.inputStream = this.process.stdin;
      this.outputStream = this.process.stdout;

      // Handle stdout (responses from target server)
      this.outputStream.on('data', (chunk) => {
        this.handleData(chunk);
      });

      // Handle stderr (logs from target server)
      this.process.stderr.on('data', (chunk) => {
        const msg = chunk.toString();
        if (process.env.MCP_CACHE_DEBUG === 'true') {
          console.error('[target server stderr]:', msg);
        }
      });

      // Handle process exit
      this.process.on('exit', (code) => {
        console.error(`Target server exited with code ${code}`);
      });

      // Handle process errors
      this.process.on('error', (error) => {
        console.error('Target server error:', error);
        reject(error);
      });

      // Give the process a moment to start
      setTimeout(() => resolve(), 100);
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    // Process complete JSON-RPC messages
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse message:', line, error);
        }
      }
    }
  }

  private handleMessage(message: any): void {
    if (message.id !== undefined) {
      // Response to a request
      const handler = this.messageHandlers.get(message.id);
      if (handler) {
        handler(message);
        this.messageHandlers.delete(message.id);
      }
    } else if (message.method) {
      // Notification from server
      this.notificationHandlers.forEach(h => h(message));
    }
  }

  async sendRequest(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params: params || {},
      };

      this.messageHandlers.set(id, (response) => {
        if (response.error) {
          reject(new Error(response.error.message || 'Unknown error'));
        } else {
          resolve(response.result);
        }
      });

      const message = JSON.stringify(request) + '\n';
      this.inputStream?.write(message);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.messageHandlers.has(id)) {
          this.messageHandlers.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  async sendNotification(method: string, params?: any): Promise<void> {
    const notification = {
      jsonrpc: '2.0',
      method,
      params: params || {},
    };

    const message = JSON.stringify(notification) + '\n';
    this.inputStream?.write(message);
  }

  onNotification(handler: (notification: any) => void): void {
    this.notificationHandlers.push(handler);
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }
  }
}