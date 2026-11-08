import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export const config = {
  apiKey: process.env.MODEL_API_KEY || '',
  model: process.env.MUSE_MODEL || '',
  curatorModel: process.env.MUSE_CURATOR_MODEL || '',
  baseUrl: (process.env.MUSE_BASE_URL || 'https://api.meta.ai/v1').replace(/\/$/, ''),
  dataDir: path.resolve(process.env.KITO_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'kito')),
  maxSteps: 80,
  toolOutputLimit: 18000,
};

export function requireModelConfig() {
  if (!config.apiKey || !config.model) throw new Error('Set MODEL_API_KEY and MUSE_MODEL in .env before running an application.');
}
