import { serverConfig } from './config.js';
import { createGateway } from './gateway.js';
import { WhisperServerProvider } from './whisper.js';

const provider = new WhisperServerProvider({
  binary: serverConfig.whisperServerBin,
  model: serverConfig.whisperModel,
  host: serverConfig.whisperHost,
  port: serverConfig.whisperPort,
  language: serverConfig.language,
  threads: serverConfig.threads,
  beamSize: serverConfig.beamSize,
  startupTimeoutMs: serverConfig.startupTimeoutMs,
  externalUrl: serverConfig.whisperServerUrl || undefined,
  log: (message) => app.log.info(message)
});

const app = await createGateway(provider, serverConfig);

async function shutdown(signal: string) {
  app.log.info(`${signal} 수신. 종료합니다.`);
  try {
    await provider.stop();
  } catch {
    /* 무시 */
  }
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: serverConfig.port, host: serverConfig.host });
app.log.info(`STT 게이트웨이 준비: ws://${serverConfig.host}:${serverConfig.port}/v1/transcription`);
app.log.info(`whisper 모델을 메모리에 올리는 중: ${serverConfig.whisperModel}`);

// 모델 로딩을 미리 시작해 첫 자막 지연을 줄인다. 실패해도 게이트웨이는 계속 떠 있는다.
void provider.start().catch((err) => app.log.error(String(err?.message ?? err)));
