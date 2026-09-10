import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');

/** scripts/setup-whisper.sh 가 남긴 경로를 읽어온다. 환경변수가 항상 우선한다. */
function readWhisperEnv(): Record<string, string> {
  const file = path.join(repoRoot, '.whisper-env');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

const fromFile = readWhisperEnv();
const pick = (key: string, fallback: string) => process.env[key] ?? fromFile[key] ?? fallback;

export interface ServerConfig {
  port: number;
  host: string;
  whisperServerBin: string;
  whisperModel: string;
  /** 이미 떠 있는 whisper-server 에 붙을 때 사용. 설정되면 프로세스를 새로 띄우지 않는다. */
  whisperServerUrl: string;
  whisperHost: string;
  whisperPort: number;
  language: string;
  threads: number;
  /** Whisper 는 16kHz mono PCM16 만 받는다. */
  sampleRate: number;
  windowMs: number;
  overlapMs: number;
  /** beam search 폭. 0 이하면 greedy. 클수록 정확하지만 느리다. */
  beamSize: number;
  /** 자막 한 줄의 최대 길이(ms). 문장이 안 끝나도 여기서 끊는다. */
  lineMaxMs: number;
  /** 자막 한 줄의 최대 글자 수. */
  lineMaxChars: number;
  /** 직전 자막을 Whisper 프롬프트로 얼마나 되돌려줄지(글자 수). */
  promptContextChars: number;
  /** 이 RMS 미만이면 무음으로 보고 Whisper 를 호출하지 않는다. */
  minRms: number;
  /** 처리 대기 오디오 상한(초). 넘으면 오래된 오디오를 버려 지연이 누적되지 않게 한다. */
  maxBacklogSec: number;
  startupTimeoutMs: number;
}

export const serverConfig: ServerConfig = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  whisperServerBin: pick('WHISPER_SERVER_BIN', path.join(repoRoot, 'vendor/whisper.cpp/build/bin/whisper-server')),
  whisperModel: pick('WHISPER_MODEL', path.join(repoRoot, 'models/ggml-small.bin')),
  whisperServerUrl: process.env.WHISPER_SERVER_URL ?? '',
  whisperHost: process.env.WHISPER_HOST ?? '127.0.0.1',
  whisperPort: Number(process.env.WHISPER_PORT ?? 8788),
  language: process.env.WHISPER_LANGUAGE ?? 'ko',
  threads: Number(process.env.WHISPER_THREADS ?? Math.max(4, Math.floor(os.cpus().length / 2))),
  sampleRate: 16000,
  // 3초 window 는 한국어 한 문장을 담지 못해 단어가 경계에서 잘리고 자막이 잘게 부서졌다.
  // 5초/1.2초 겹침이면 문장 대부분이 한 window 안에 들어온다(§자막 품질).
  windowMs: Number(process.env.STT_WINDOW_MS ?? 5000),
  overlapMs: Number(process.env.STT_OVERLAP_MS ?? 1200),
  beamSize: Number(process.env.WHISPER_BEAM_SIZE ?? 3),
  lineMaxMs: Number(process.env.STT_LINE_MAX_MS ?? 15000),
  lineMaxChars: Number(process.env.STT_LINE_MAX_CHARS ?? 90),
  promptContextChars: Number(process.env.STT_PROMPT_CONTEXT_CHARS ?? 260),
  minRms: Number(process.env.STT_MIN_RMS ?? 180),
  maxBacklogSec: Number(process.env.STT_MAX_BACKLOG_SEC ?? 20),
  startupTimeoutMs: Number(process.env.WHISPER_STARTUP_TIMEOUT_MS ?? 180000)
};
