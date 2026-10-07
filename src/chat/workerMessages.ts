import type { ChatStore } from './types';

export type ParseRequest = { file: File };
export type ParseResponse =
  | { type: 'progress'; count: number }
  | { type: 'done'; store: ChatStore }
  | { type: 'error'; message: string };
