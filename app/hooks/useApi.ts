/**
 * API Hooks for communicating with CLI via WebSocket
 *
 * Usage:
 *   const { fs, git, processes, ports, monitor, http } = useApi();
 *   const files = await fs.list('/src');
 *   const status = await git.status();
 */

import { useCallback } from 'react';
import { useConnection, ProtocolResponse } from '@/contexts/ConnectionContext';
import { logger } from '@/lib/logger';

// ============================================================================
// Types
// ============================================================================

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: number;
}

export interface FileStat {
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime: number;
  mode: number;
  isBinary?: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: Array<{ path: string; status: string }>;
  unstaged: Array<{ path: string; status: string }>;
  untracked: string[];
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: number;
}

export interface GitCommitFile {
  path: string;
  status: string;
}

export interface GitCommitDetails {
  commit: GitCommit & { fullHash: string };
  files: GitCommitFile[];
  diff: string;
  fileDiffs: Record<string, string>;
}

export interface ProcessInfo {
  pid: number;
  command: string;
  startTime: number;
  status: 'running' | 'stopped';
  channel: string;
  cwd?: string;
}

export interface PortInfo {
  port: number;
  pid: number;
  process: string;
  address: string;
}

export interface PortKillResult {
  port: number;
  pid: number | null;
  ownerPid?: number | null;
  killed: boolean;
  stillListening: boolean;
  currentPid: number | null;
}

export interface CpuInfo {
  usage: number;
  cores: number[];
  model?: string;
  speed?: number;
}

export interface MemoryInfo {
  total: number;
  used: number;
  free: number;
  usedPercent: number;
}

export interface DiskInfo {
  mount: string;
  filesystem: string;
  size: number;
  used: number;
  free: number;
  usedPercent: number;
}

export interface BatteryInfo {
  hasBattery: boolean;
  percent: number;
  charging: boolean;
  timeRemaining: number | null;
}

export interface SystemInfo {
  cpu: CpuInfo;
  memory: MemoryInfo;
  disk: DiskInfo[];
  battery: BatteryInfo;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timing: number;
}

// ============================================================================
// Error Handling
// ============================================================================

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ApiError';
  }
}

function handleResponse<T>(response: ProtocolResponse): T {
  if (!response.ok) {
    throw new ApiError(
      response.error?.code || 'UNKNOWN',
      response.error?.message || 'Unknown error'
    );
  }
  return response.payload as T;
}

// ============================================================================
// Hook
// ============================================================================

export function useApi() {
  const { sendControl, sendData, status } = useConnection();

  const isConnected = status === 'connected';

  // ============================================================================
  // File System API
  // ============================================================================

  const fs = {
    /**
     * List directory contents
     */
    list: useCallback(async (path: string = '.'): Promise<FileEntry[]> => {
      const response = await sendControl('fs', 'ls', { path });
      const result = handleResponse<{ entries: FileEntry[] }>(response);
      return result.entries;
    }, [sendControl]),

    /**
     * Get file/directory metadata
     */
    stat: useCallback(async (path: string): Promise<FileStat> => {
      const response = await sendControl('fs', 'stat', { path });
      return handleResponse<FileStat>(response);
    }, [sendControl]),

    /**
     * Read file contents
     */
    read: useCallback(async (path: string): Promise<FileContent> => {
      const startedAt = Date.now();
      logger.info('fs-api', 'read requested', { path });
      const response = await sendData('fs', 'read', { path });
      const result = handleResponse<FileContent>(response);
      logger.info('fs-api', 'read completed', {
        path,
        encoding: result.encoding,
        size: result.size,
        contentLength: result.content.length,
        durationMs: Date.now() - startedAt,
      });
      return result;
    }, [sendData]),

    /**
     * Write file contents
     */
    write: useCallback(async (
      path: string,
      content: string,
      encoding: 'utf8' | 'base64' = 'utf8',
      timeoutMs?: number,
      options?: { source?: string },
    ): Promise<void> => {
      const response = await sendData('fs', 'write', { path, content, encoding, source: options?.source }, timeoutMs);
      handleResponse<{ path: string }>(response);
    }, [sendData]),

    /**
     * Create file or directory
     */
    create: useCallback(async (path: string, type: 'file' | 'directory'): Promise<void> => {
      const response = await sendControl('fs', 'create', { path, type });
      handleResponse<{ path: string }>(response);
    }, [sendControl]),

    /**
     * Create directory
     */
    mkdir: useCallback(async (path: string, recursive: boolean = true): Promise<void> => {
      const response = await sendControl('fs', 'mkdir', { path, recursive });
      handleResponse<{ path: string }>(response);
    }, [sendControl]),

    /**
     * Delete file or directory
     */
    remove: useCallback(async (path: string, recursive: boolean = true): Promise<void> => {
      const response = await sendControl('fs', 'rm', { path, recursive });
      handleResponse<{ path: string }>(response);
    }, [sendControl]),

    /**
     * Move/rename file or directory
     */
    move: useCallback(async (from: string, to: string): Promise<void> => {
      const response = await sendControl('fs', 'mv', { from, to });
      handleResponse<{ from: string; to: string }>(response);
    }, [sendControl]),

    /**
     * Search for pattern in files
     */
    grep: useCallback(async (
      pattern: string,
      path: string = '.',
      options?: { caseSensitive?: boolean; maxResults?: number }
    ): Promise<GrepMatch[]> => {
      const response = await sendControl('fs', 'grep', {
        path,
        pattern,
        caseSensitive: options?.caseSensitive ?? true,
        maxResults: options?.maxResults ?? 100,
      });
      const result = handleResponse<{ matches: GrepMatch[] }>(response);
      return result.matches;
    }, [sendControl]),
  };

  // ============================================================================
  // Git API
  // ============================================================================

  const git = {
    /**
     * Get repository status
     */
    status: useCallback(async (): Promise<GitStatus> => {
      const response = await sendControl('git', 'status');
      return handleResponse<GitStatus>(response);
    }, [sendControl]),

    /**
     * Stage files
     */
    stage: useCallback(async (paths: string[]): Promise<void> => {
      const response = await sendControl('git', 'stage', { paths });
      handleResponse<{}>(response);
    }, [sendControl]),

    /**
     * Unstage files
     */
    unstage: useCallback(async (paths: string[]): Promise<void> => {
      const response = await sendControl('git', 'unstage', { paths });
      handleResponse<{}>(response);
    }, [sendControl]),

    /**
     * Create a commit
     */
    commit: useCallback(async (message: string): Promise<{ hash: string }> => {
      const response = await sendControl('git', 'commit', { message });
      return handleResponse<{ hash: string; message: string }>(response);
    }, [sendControl]),

    /**
     * Get commit log
     */
    log: useCallback(async (limit: number = 20): Promise<GitCommit[]> => {
      const response = await sendControl('git', 'log', { limit });
      const result = handleResponse<{ commits: GitCommit[] }>(response);
      return result.commits;
    }, [sendControl]),

    /**
     * Get commit details including changed files and patch
     */
    commitDetails: useCallback(async (hash: string): Promise<GitCommitDetails> => {
      const response = await sendControl('git', 'commitDetails', { hash });
      return handleResponse<GitCommitDetails>(response);
    }, [sendControl]),

    /**
     * Get diff
     */
    diff: useCallback(async (path?: string, staged: boolean = false): Promise<string> => {
      const response = await sendData('git', 'diff', { path, staged });
      const result = handleResponse<{ diff: string }>(response);
      return result.diff;
    }, [sendData]),

    /**
     * List branches
     */
    branches: useCallback(async (): Promise<{ current: string; branches: string[] }> => {
      const response = await sendControl('git', 'branches');
      return handleResponse<{ current: string; branches: string[] }>(response);
    }, [sendControl]),

    /**
     * Checkout branch
     */
    checkout: useCallback(async (branch: string, create: boolean = false): Promise<void> => {
      const response = await sendControl('git', 'checkout', { branch, create });
      handleResponse<{ branch: string }>(response);
    }, [sendControl]),

    /**
     * Delete a branch
     */
    deleteBranch: useCallback(async (branch: string): Promise<void> => {
      const response = await sendControl('git', 'deleteBranch', { branch });
      handleResponse<{ branch: string }>(response);
    }, [sendControl]),

    /**
     * Pull from remote
     */
    pull: useCallback(async (strategy?: 'merge' | 'rebase' | 'ff-only'): Promise<{ success: boolean; summary: string }> => {
      const response = await sendControl('git', 'pull', strategy ? { strategy } : undefined);
      return handleResponse<{ success: boolean; summary: string }>(response);
    }, [sendControl]),

    /**
     * Push to remote
     */
    push: useCallback(async (setUpstream: boolean = false, force?: 'force-with-lease' | 'force'): Promise<void> => {
      const response = await sendControl('git', 'push', { setUpstream, ...(force ? { force } : {}) });
      handleResponse<{ success: boolean }>(response);
    }, [sendControl]),

    /**
     * Discard changes
     */
    discard: useCallback(async (paths?: string[]): Promise<void> => {
      const payload = paths ? { paths } : { all: true };
      const response = await sendControl('git', 'discard', payload);
      handleResponse<{}>(response);
    }, [sendControl]),
  };

  // ============================================================================
  // Processes API
  // ============================================================================

  const processes = {
    /**
     * List managed processes
     */
    list: useCallback(async (): Promise<ProcessInfo[]> => {
      const response = await sendControl('processes', 'list');
      const result = handleResponse<{ processes: ProcessInfo[] }>(response);
      return result.processes;
    }, [sendControl]),

    /**
     * Spawn a new process
     */
    spawn: useCallback(async (
      command: string,
      args?: string[],
      options?: { cwd?: string; env?: Record<string, string> }
    ): Promise<{ pid: number; channel: string }> => {
      const response = await sendControl('processes', 'spawn', {
        command,
        args: args || [],
        cwd: options?.cwd,
        env: options?.env,
      });
      return handleResponse<{ pid: number; channel: string }>(response);
    }, [sendControl]),

    /**
     * Kill a process
     */
    kill: useCallback(async (pid: number): Promise<void> => {
      const response = await sendControl('processes', 'kill', { pid });
      handleResponse<{}>(response);
    }, [sendControl]),

    /**
     * Get process output
     */
    getOutput: useCallback(async (channel: string): Promise<string> => {
      const response = await sendControl('processes', 'getOutput', { channel });
      const result = handleResponse<{ output: string }>(response);
      return result.output;
    }, [sendControl]),

    /**
     * Clear process output
     */
    clearOutput: useCallback(async (channel?: string): Promise<void> => {
      const response = await sendControl('processes', 'clearOutput', { channel });
      handleResponse<{}>(response);
    }, [sendControl]),
  };

  // ============================================================================
  // Ports API
  // ============================================================================

  const ports = {
    /**
     * List listening ports
     */
    list: useCallback(async (): Promise<PortInfo[]> => {
      const response = await sendControl('ports', 'list');
      const result = handleResponse<{ ports: PortInfo[] }>(response);
      return result.ports;
    }, [sendControl]),

    /**
     * Check if port is available
     */
    isAvailable: useCallback(async (port: number): Promise<boolean> => {
      const response = await sendControl('ports', 'isAvailable', { port });
      const result = handleResponse<{ available: boolean }>(response);
      return result.available;
    }, [sendControl]),

    /**
     * Kill process using port
     */
    kill: useCallback(async (port: number): Promise<PortKillResult> => {
      const response = await sendControl('ports', 'kill', { port });
      return handleResponse<PortKillResult>(response);
    }, [sendControl]),
  };

  // ============================================================================
  // Monitor API
  // ============================================================================

  const monitor = {
    /**
     * Get all system info
     */
    system: useCallback(async (): Promise<SystemInfo> => {
      const response = await sendControl('monitor', 'system');
      return handleResponse<SystemInfo>(response);
    }, [sendControl]),

    /**
     * Get CPU usage
     */
    cpu: useCallback(async (): Promise<CpuInfo> => {
      const response = await sendControl('monitor', 'cpu');
      return handleResponse<CpuInfo>(response);
    }, [sendControl]),

    /**
     * Get memory usage
     */
    memory: useCallback(async (): Promise<MemoryInfo> => {
      const response = await sendControl('monitor', 'memory');
      return handleResponse<MemoryInfo>(response);
    }, [sendControl]),

    /**
     * Get disk usage
     */
    disk: useCallback(async (): Promise<DiskInfo[]> => {
      const response = await sendControl('monitor', 'disk');
      const result = handleResponse<{ disks: DiskInfo[] }>(response);
      return result.disks;
    }, [sendControl]),

    /**
     * Get battery status
     */
    battery: useCallback(async (): Promise<BatteryInfo> => {
      const response = await sendControl('monitor', 'battery');
      return handleResponse<BatteryInfo>(response);
    }, [sendControl]),
  };

  // ============================================================================
  // HTTP API
  // ============================================================================

  const http = {
    /**
     * Make HTTP request
     */
    request: useCallback(async (config: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: string;
      timeout?: number;
    }): Promise<HttpResponse> => {
      const response = await sendData('http', 'request', config);
      return handleResponse<HttpResponse>(response);
    }, [sendData]),

    // Convenience methods
    get: useCallback(async (url: string, headers?: Record<string, string>): Promise<HttpResponse> => {
      const response = await sendData('http', 'request', { method: 'GET', url, headers });
      return handleResponse<HttpResponse>(response);
    }, [sendData]),

    post: useCallback(async (url: string, body?: string, headers?: Record<string, string>): Promise<HttpResponse> => {
      const response = await sendData('http', 'request', { method: 'POST', url, body, headers });
      return handleResponse<HttpResponse>(response);
    }, [sendData]),

    put: useCallback(async (url: string, body?: string, headers?: Record<string, string>): Promise<HttpResponse> => {
      const response = await sendData('http', 'request', { method: 'PUT', url, body, headers });
      return handleResponse<HttpResponse>(response);
    }, [sendData]),

    delete: useCallback(async (url: string, headers?: Record<string, string>): Promise<HttpResponse> => {
      const response = await sendData('http', 'request', { method: 'DELETE', url, headers });
      return handleResponse<HttpResponse>(response);
    }, [sendData]),
  };

  return {
    isConnected,
    fs,
    git,
    processes,
    ports,
    monitor,
    http,
  };
}

export default useApi;
