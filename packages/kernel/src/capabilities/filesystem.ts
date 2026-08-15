import type { Result } from "./outcomes.js";

export type FileKind = "file" | "directory" | "symlink" | "other";

interface FileLocation {
  name: string;
  path: string;
}

interface FileMetadata {
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

export interface FileInfo extends FileLocation, FileMetadata {}

export type FileErrorCode =
  | "aborted"
  | "not_found"
  | "not_directory"
  | "not_file"
  | "permission_denied"
  | "limit_exceeded"
  | "invalid_path"
  | "not_supported"
  | "unknown";

export class FileError extends Error {
  readonly code: FileErrorCode;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: FileErrorCode, message: string, path?: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "FileError";
    this.code = code;
    if (path !== undefined) this.path = path;
    if (details !== undefined) this.details = details;
  }
}

export type FileWriteContent = string | Uint8Array | AsyncIterable<Uint8Array>;

type FileOperation<T> = Promise<Result<T, FileError>>;

interface FilePathAccess {
  readonly cwd: string;
  absolutePath(path: string): FileOperation<string>;
  canonicalPath(path: string): FileOperation<string>;
}

interface FileReadAccess {
  fileInfo(path: string, signal?: AbortSignal): FileOperation<FileInfo>;
  listDir(path: string, signal?: AbortSignal): FileOperation<FileInfo[]>;
  exists(path: string, signal?: AbortSignal): FileOperation<boolean>;
  readTextFile(path: string, signal?: AbortSignal, maxBytes?: number): FileOperation<string>;
  readTextLines(path: string, options?: FileLineReadOptions): FileOperation<string[]>;
  readBinaryFile(path: string, signal?: AbortSignal, maxBytes?: number): FileOperation<Uint8Array>;
}

interface FileMutationAccess {
  writeFile(path: string, content: FileWriteContent, signal?: AbortSignal): FileOperation<void>;
  replaceFile(path: string, content: FileWriteContent, signal?: AbortSignal): FileOperation<void>;
  appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal): FileOperation<void>;
  createDir(path: string, options?: DirectoryCreateOptions, signal?: AbortSignal): FileOperation<void>;
}

interface TemporaryFileAccess {
  createTempFile(options?: TemporaryFileOptions): FileOperation<{ path: string }>;
}

interface FileLineReadOptions {
  maxLines?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

interface DirectoryCreateOptions {
  recursive?: boolean;
}

interface TemporaryFileOptions {
  prefix?: string;
  suffix?: string;
  directory?: string;
}

export interface FileAccess extends FilePathAccess, FileReadAccess, FileMutationAccess, TemporaryFileAccess {}
